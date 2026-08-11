import type pg from "pg";

/** One pre-approved appointment slot. The far end may only ever pick one of these. */
export interface CandidateSlot {
  /** Short, stable, easy to say back: `s1`, `s2`, … */
  id: string;
  startsAt: string;
  endsAt: string;
}

export type MandateState =
  | "pending"
  | "agreed"
  | "recorded"
  | "declined"
  | "unresolved"
  | "failed"
  | "expired";

export interface CallMandateRow {
  id: string;
  userId: string;
  callLogId: string;
  contactId: string | null;
  errand: string;
  /** null means: may ask, may agree to nothing. */
  candidateSlots: CandidateSlot[] | null;
  durationMinutes: number | null;
  expiresAt: Date;
  state: MandateState;
  agreedSlotId: string | null;
  eventUid: string | null;
  resolutionNote: string | null;
  createdAt: Date;
}

/**
 * What the agent was allowed to agree to, frozen before the call was placed.
 *
 * Nothing here is ever written from a transcript. `agreedSlotId` is only ever
 * set to the id of a slot that is already in `candidateSlots`.
 */
export class MandateRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: {
    userId: string;
    callLogId: string;
    contactId?: string | null;
    errand: string;
    candidateSlots?: CandidateSlot[] | null;
    durationMinutes?: number | null;
    expiresAt: Date;
  }): Promise<CallMandateRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO call_mandates
         (user_id, call_log_id, contact_id, errand, candidate_slots, duration_minutes, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       RETURNING ${COLUMNS}`,
      [
        input.userId,
        input.callLogId,
        input.contactId ?? null,
        input.errand,
        input.candidateSlots ? JSON.stringify(input.candidateSlots) : null,
        input.durationMinutes ?? null,
        input.expiresAt,
      ],
    );
    return toRow(rows[0] as Record<string, unknown>);
  }

  async findByCall(callLogId: string): Promise<CallMandateRow | null> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM call_mandates WHERE call_log_id = $1`,
      [callLogId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  /**
   * Records the outcome.
   *
   * `agreedSlotId` is validated against the mandate's own set by the caller
   * before it gets here — this method stores a decision, it does not make one.
   */
  async resolve(
    id: string,
    patch: {
      state: MandateState;
      agreedSlotId?: string | null;
      eventUid?: string | null;
      note?: string | null;
    },
  ): Promise<CallMandateRow | null> {
    const { rows } = await this.pool.query(
      `UPDATE call_mandates SET
         state = $2,
         agreed_slot_id  = COALESCE($3, agreed_slot_id),
         event_uid       = COALESCE($4, event_uid),
         resolution_note = COALESCE($5, resolution_note),
         updated_at = now()
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [id, patch.state, patch.agreedSlotId ?? null, patch.eventUid ?? null, patch.note ?? null],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  /** Open mandates past their deadline, for the expiry sweep and the admin UI. */
  async listStale(now = new Date()): Promise<CallMandateRow[]> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM call_mandates
        WHERE state IN ('pending', 'agreed') AND expires_at < $1
        ORDER BY expires_at`,
      [now],
    );
    return rows.map((row) => toRow(row as Record<string, unknown>));
  }
}

const COLUMNS = `id, user_id, call_log_id, contact_id, errand, candidate_slots,
                 duration_minutes, expires_at, state, agreed_slot_id, event_uid,
                 resolution_note, created_at`;

function toRow(r: Record<string, unknown>): CallMandateRow {
  return {
    id: r["id"] as string,
    userId: r["user_id"] as string,
    callLogId: r["call_log_id"] as string,
    contactId: (r["contact_id"] as string | null) ?? null,
    errand: r["errand"] as string,
    candidateSlots: (r["candidate_slots"] as CandidateSlot[] | null) ?? null,
    durationMinutes: (r["duration_minutes"] as number | null) ?? null,
    expiresAt: r["expires_at"] as Date,
    state: r["state"] as MandateState,
    agreedSlotId: (r["agreed_slot_id"] as string | null) ?? null,
    eventUid: (r["event_uid"] as string | null) ?? null,
    resolutionNote: (r["resolution_note"] as string | null) ?? null,
    createdAt: r["created_at"] as Date,
  };
}
