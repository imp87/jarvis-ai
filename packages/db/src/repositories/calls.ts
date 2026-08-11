import type pg from "pg";
import type { CallBudgetUsage, CallClass } from "@jarvis/shared";

export type CallStatus =
  | "requested"
  | "blocked"
  | "dialing"
  | "in_progress"
  | "completed"
  | "failed";

/** One spoken turn. `other` is the far end — personal data of a third party. */
export interface TranscriptEntry {
  at: string;
  speaker: "agent" | "other";
  text: string;
}

export interface CallLogRow {
  id: string;
  conversationId: string | null;
  toNumber: string;
  reason: string;
  status: CallStatus;
  blockedReason: string | null;
  /** Which allowance the call drew on. See `CallClass`. */
  kind: CallClass;
  createdAt: Date;
}

export class CallRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Counts calls that actually reached the network. `requested` and `blocked`
   * rows are excluded so a policy rejection never consumes budget.
   *
   * Counted per class: reminders and system alerts have separate allowances, so
   * a busy day of the former can never exhaust the latter.
   */
  async budgetUsage(kind: CallClass = "normal"): Promise<CallBudgetUsage> {
    const { rows } = await this.pool.query<{ last_hour: string; last_day: string }>(
      `SELECT
         count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS last_hour,
         count(*) FILTER (WHERE created_at > now() - interval '1 day')  AS last_day
       FROM call_logs
       WHERE status IN ('dialing', 'in_progress', 'completed')
         AND kind = $1`,
      [kind],
    );
    const row = rows[0]!;
    return { lastHour: Number(row.last_hour), lastDay: Number(row.last_day) };
  }

  async record(input: {
    conversationId?: string | null;
    toNumber: string;
    reason: string;
    status: CallStatus;
    blockedReason?: string | null;
    /** Which allowance this call draws on. Defaults to an ordinary call. */
    kind?: CallClass;
  }): Promise<CallLogRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO call_logs (conversation_id, direction, to_number, reason, status, blocked_reason, kind)
       VALUES ($1, 'outbound', $2, $3, $4, $5, $6)
       RETURNING ${CALL_COLUMNS}`,
      [
        input.conversationId ?? null,
        input.toNumber,
        input.reason,
        input.status,
        input.blockedReason ?? null,
        input.kind ?? "normal",
      ],
    );
    return toCallLogRow(rows[0] as Record<string, unknown>);
  }

  /**
   * Appends one spoken turn to the call's transcript.
   *
   * Appended in the database rather than read-modify-written in code: two turns
   * can be in flight at once on a live call, and a lost one is a hole in the
   * audit trail for a commitment made in the owner's name.
   *
   * The column has existed since 001 and was never written until outbound calls
   * to third parties made it the record of what was actually said.
   */
  async appendTranscript(id: string, entry: TranscriptEntry): Promise<void> {
    await this.pool.query(
      `UPDATE call_logs
          SET transcript = COALESCE(transcript, '[]'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [id, JSON.stringify([entry])],
    );
  }

  async transcriptOf(id: string): Promise<TranscriptEntry[]> {
    const { rows } = await this.pool.query<{ transcript: TranscriptEntry[] | null }>(
      `SELECT transcript FROM call_logs WHERE id = $1`,
      [id],
    );
    return rows[0]?.transcript ?? [];
  }

  async updateStatus(
    id: string,
    status: CallStatus,
    patch: {
      providerCallId?: string;
      transcript?: unknown;
      durationSeconds?: number;
      startedAt?: Date;
      endedAt?: Date;
    } = {},
  ): Promise<void> {
    await this.pool.query(
      `UPDATE call_logs
          SET status = $2,
              provider_call_id = COALESCE($3, provider_call_id),
              transcript       = COALESCE($4::jsonb, transcript),
              duration_seconds = COALESCE($5, duration_seconds),
              started_at       = COALESCE($6, started_at),
              ended_at         = COALESCE($7, ended_at)
        WHERE id = $1`,
      [
        id,
        status,
        patch.providerCallId ?? null,
        patch.transcript ? JSON.stringify(patch.transcript) : null,
        patch.durationSeconds ?? null,
        patch.startedAt ?? null,
        patch.endedAt ?? null,
      ],
    );
  }

  async get(id: string): Promise<CallLogRow | null> {
    const { rows } = await this.pool.query(
      `SELECT ${CALL_COLUMNS} FROM call_logs WHERE id = $1`,
      [id],
    );
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? toCallLogRow(r) : null;
  }

  async list(limit = 50): Promise<CallLogRow[]> {
    const { rows } = await this.pool.query(
      `SELECT ${CALL_COLUMNS} FROM call_logs ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return (rows as Array<Record<string, unknown>>).map(toCallLogRow);
  }
}

const CALL_COLUMNS = `id, conversation_id, to_number, reason, status, blocked_reason, kind, created_at`;

function toCallLogRow(r: Record<string, unknown>): CallLogRow {
  return {
    id: r["id"] as string,
    conversationId: (r["conversation_id"] as string | null) ?? null,
    toNumber: r["to_number"] as string,
    reason: r["reason"] as string,
    status: r["status"] as CallStatus,
    blockedReason: (r["blocked_reason"] as string | null) ?? null,
    // Rows written before migration 013 have no class of their own; they were
    // all ordinary calls, which is what the column defaults to.
    kind: (r["kind"] as CallClass | null) ?? "normal",
    createdAt: r["created_at"] as Date,
  };
}
