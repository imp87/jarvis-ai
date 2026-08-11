import type pg from "pg";
import { normalisePhoneNumber } from "@jarvis/shared";

export interface ContactRow {
  id: string;
  userId: string;
  name: string;
  phoneE164: string;
  note: string | null;
  /** Whether the agent may dial this contact. Never set by the model. */
  allowCalls: boolean;
  createdBy: "user" | "agent";
  createdAt: Date;
}

/** Raised when a contact name is already taken. Never an update — see `create`. */
export class ContactExistsError extends Error {
  constructor(readonly contactName: string) {
    super(`a contact named "${contactName}" already exists`);
    this.name = "ContactExistsError";
  }
}

/**
 * The only place a phone number the agent may dial can come from.
 *
 * Numbers are normalised to E.164 on the way in, so `0155…`, `+49155…` and
 * `0049155…` collapse to one row rather than three that look identical in the
 * UI and compare unequal in code.
 */
export class ContactRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(userId: string): Promise<ContactRow[]> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM contacts WHERE user_id = $1 ORDER BY name`,
      [userId],
    );
    return rows.map((row) => toRow(row as Record<string, unknown>));
  }

  async get(userId: string, id: string): Promise<ContactRow | null> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM contacts WHERE user_id = $1 AND id = $2`,
      [userId, id],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  /**
   * Creates a contact. Never updates one.
   *
   * `ON CONFLICT DO NOTHING` plus an explicit throw rather than an upsert: the
   * agent calls this path, and an upsert would let text it read somewhere
   * replace the number behind a name the owner has already approved — the new
   * number would inherit `allow_calls` and the next call would go elsewhere.
   * Editing stays with the owner.
   */
  async create(input: {
    userId: string;
    name: string;
    phone: string;
    note?: string | null;
    createdBy: "user" | "agent";
    /** Only ever true from an owner-driven path. */
    allowCalls?: boolean;
  }): Promise<ContactRow> {
    const name = input.name.trim();
    const { rows } = await this.pool.query(
      `INSERT INTO contacts (user_id, name, phone_e164, note, created_by, allow_calls)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, name) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.userId,
        name,
        normalisePhoneNumber(input.phone),
        input.note?.trim() || null,
        input.createdBy,
        input.allowCalls ?? false,
      ],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new ContactExistsError(name);
    return toRow(row);
  }

  /** Owner-only. The agent has no route to this. */
  async update(
    userId: string,
    id: string,
    patch: { name?: string; phone?: string; note?: string | null; allowCalls?: boolean },
  ): Promise<ContactRow | null> {
    const { rows } = await this.pool.query(
      `UPDATE contacts SET
         name        = COALESCE($3, name),
         phone_e164  = COALESCE($4, phone_e164),
         note        = CASE WHEN $5::boolean THEN $6 ELSE note END,
         allow_calls = COALESCE($7, allow_calls),
         updated_at  = now()
       WHERE user_id = $1 AND id = $2
       RETURNING ${COLUMNS}`,
      [
        userId,
        id,
        patch.name?.trim() ?? null,
        patch.phone ? normalisePhoneNumber(patch.phone) : null,
        patch.note !== undefined,
        patch.note?.trim() ?? null,
        patch.allowCalls ?? null,
      ],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM contacts WHERE user_id = $1 AND id = $2`,
      [userId, id],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Contacts whose name matches, for resolving what the model asked for.
   *
   * Exact (case-insensitive) matches are returned alone when there are any:
   * a contact literally named "Friseur" must win over "Friseur Zweitsalon"
   * rather than making the pair ambiguous. Only when nothing matches exactly
   * does this fall back to a substring search, so "Salon" can still find
   * "Salon Meier".
   */
  async findByName(userId: string, needle: string): Promise<ContactRow[]> {
    const term = needle.trim();
    if (!term) return [];
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM contacts
        WHERE user_id = $1 AND (lower(name) = lower($2) OR name ILIKE '%' || $2 || '%')
        ORDER BY name`,
      [userId, term],
    );
    const all = rows.map((row) => toRow(row as Record<string, unknown>));
    const exact = all.filter((contact) => contact.name.toLowerCase() === term.toLowerCase());
    return exact.length > 0 ? exact : all;
  }
}

const COLUMNS = `id, user_id, name, phone_e164, note, allow_calls, created_by, created_at`;

function toRow(r: Record<string, unknown>): ContactRow {
  return {
    id: r["id"] as string,
    userId: r["user_id"] as string,
    name: r["name"] as string,
    phoneE164: r["phone_e164"] as string,
    note: (r["note"] as string | null) ?? null,
    allowCalls: r["allow_calls"] as boolean,
    createdBy: (r["created_by"] as "user" | "agent" | null) ?? "user",
    createdAt: r["created_at"] as Date,
  };
}
