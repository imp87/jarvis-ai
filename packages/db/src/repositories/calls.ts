import type pg from "pg";
import type { CallBudgetUsage } from "@jarvis/shared";

export type CallStatus =
  | "requested"
  | "blocked"
  | "dialing"
  | "in_progress"
  | "completed"
  | "failed";

export interface CallLogRow {
  id: string;
  conversationId: string | null;
  toNumber: string;
  reason: string;
  status: CallStatus;
  blockedReason: string | null;
  createdAt: Date;
}

export class CallRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Counts calls that actually reached the network. `requested` and `blocked`
   * rows are excluded so a policy rejection never consumes budget.
   */
  async budgetUsage(): Promise<CallBudgetUsage> {
    const { rows } = await this.pool.query<{ last_hour: string; last_day: string }>(
      `SELECT
         count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS last_hour,
         count(*) FILTER (WHERE created_at > now() - interval '1 day')  AS last_day
       FROM call_logs
       WHERE status IN ('dialing', 'in_progress', 'completed')`,
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
  }): Promise<CallLogRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO call_logs (conversation_id, direction, to_number, reason, status, blocked_reason)
       VALUES ($1, 'outbound', $2, $3, $4, $5)
       RETURNING id, conversation_id, to_number, reason, status, blocked_reason, created_at`,
      [
        input.conversationId ?? null,
        input.toNumber,
        input.reason,
        input.status,
        input.blockedReason ?? null,
      ],
    );
    const r = rows[0] as Record<string, unknown>;
    return {
      id: r["id"] as string,
      conversationId: (r["conversation_id"] as string | null) ?? null,
      toNumber: r["to_number"] as string,
      reason: r["reason"] as string,
      status: r["status"] as CallStatus,
      blockedReason: (r["blocked_reason"] as string | null) ?? null,
      createdAt: r["created_at"] as Date,
    };
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

  async list(limit = 50): Promise<CallLogRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id, conversation_id, to_number, reason, status, blocked_reason, created_at
         FROM call_logs ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: r["id"] as string,
      conversationId: (r["conversation_id"] as string | null) ?? null,
      toNumber: r["to_number"] as string,
      reason: r["reason"] as string,
      status: r["status"] as CallStatus,
      blockedReason: (r["blocked_reason"] as string | null) ?? null,
      createdAt: r["created_at"] as Date,
    }));
  }
}
