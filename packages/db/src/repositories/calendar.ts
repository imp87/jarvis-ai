import type pg from "pg";

export interface CalDavAccountRow {
  id: string;
  userId: string;
  name: string;
  baseUrl: string;
  username: string;
  /** AES-GCM envelope. It never leaves the orchestrator. */
  passwordEnc: string;
  timezone: string;
  enabled: boolean;
}

export interface CalDavCalendarRow {
  id: string;
  accountId: string;
  url: string;
  displayName: string;
  ctag: string | null;
  color: string | null;
  readOnly: boolean;
  supportsEvents: boolean;
  enabled: boolean;
}

/** One discovered collection, before it is given an id by the database. */
export type DiscoveredCalendar = Omit<CalDavCalendarRow, "id" | "accountId" | "enabled">;

const ACCOUNT_COLUMNS = `id, user_id, name, base_url, username, password_enc, timezone, enabled`;
const CALENDAR_COLUMNS = `id, account_id, url, display_name, ctag, color, read_only,
                          supports_events, enabled`;

/** CalDAV account registry plus the cached result of collection discovery. */
export class CalendarRepository {
  constructor(private readonly pool: pg.Pool) {}

  async listAccounts(onlyEnabled = false): Promise<CalDavAccountRow[]> {
    const { rows } = await this.pool.query(
      `SELECT ${ACCOUNT_COLUMNS} FROM caldav_accounts
        WHERE ($1::boolean = false OR enabled = true)
        ORDER BY name`,
      [onlyEnabled],
    );
    return (rows as Array<Record<string, unknown>>).map(mapAccount);
  }

  async listAccountsForUser(userId: string, onlyEnabled = true): Promise<CalDavAccountRow[]> {
    const { rows } = await this.pool.query(
      `SELECT ${ACCOUNT_COLUMNS} FROM caldav_accounts
        WHERE user_id = $1 AND ($2::boolean = false OR enabled = true)
        ORDER BY name`,
      [userId, onlyEnabled],
    );
    return (rows as Array<Record<string, unknown>>).map(mapAccount);
  }

  async getAccount(id: string): Promise<CalDavAccountRow | null> {
    const { rows } = await this.pool.query(
      `SELECT ${ACCOUNT_COLUMNS} FROM caldav_accounts WHERE id = $1`,
      [id],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapAccount(row) : null;
  }

  async createAccount(input: Omit<CalDavAccountRow, "id" | "enabled">): Promise<CalDavAccountRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO caldav_accounts (user_id, name, base_url, username, password_enc, timezone)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING ${ACCOUNT_COLUMNS}`,
      [input.userId, input.name, input.baseUrl, input.username, input.passwordEnc, input.timezone],
    );
    return mapAccount(rows[0] as Record<string, unknown>);
  }

  async updateAccount(
    id: string,
    patch: Partial<Omit<CalDavAccountRow, "id" | "userId">>,
  ): Promise<CalDavAccountRow | null> {
    const mappings: Array<[keyof typeof patch, string]> = [
      ["name", "name"], ["baseUrl", "base_url"], ["username", "username"],
      ["passwordEnc", "password_enc"], ["timezone", "timezone"], ["enabled", "enabled"],
    ];
    const values: unknown[] = [id];
    const assignments: string[] = [];
    for (const [key, column] of mappings) {
      if (!(key in patch)) continue;
      values.push(patch[key]);
      assignments.push(`${column} = $${values.length}`);
    }
    if (assignments.length === 0) return this.getAccount(id);
    const { rows } = await this.pool.query(
      `UPDATE caldav_accounts SET ${assignments.join(", ")}, updated_at = now()
        WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
      values,
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapAccount(row) : null;
  }

  async deleteAccount(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM caldav_accounts WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async listCalendars(accountId: string, onlyEnabled = false): Promise<CalDavCalendarRow[]> {
    const { rows } = await this.pool.query(
      `SELECT ${CALENDAR_COLUMNS} FROM caldav_calendars
        WHERE account_id = $1 AND ($2::boolean = false OR enabled = true)
        ORDER BY display_name`,
      [accountId, onlyEnabled],
    );
    return (rows as Array<Record<string, unknown>>).map(mapCalendar);
  }

  /**
   * Replaces the cached collections for one account.
   *
   * Upsert rather than delete-and-insert so that a calendar the user disabled
   * stays disabled across a rediscovery — losing that on every refresh would
   * make the toggle useless.
   */
  async replaceCalendars(accountId: string, calendars: DiscoveredCalendar[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const calendar of calendars) {
        await client.query(
          `INSERT INTO caldav_calendars
             (account_id, url, display_name, ctag, color, read_only, supports_events, discovered_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, now())
           ON CONFLICT (account_id, url) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             ctag = EXCLUDED.ctag,
             color = EXCLUDED.color,
             read_only = EXCLUDED.read_only,
             supports_events = EXCLUDED.supports_events,
             discovered_at = now()`,
          [
            accountId,
            calendar.url,
            calendar.displayName,
            calendar.ctag,
            calendar.color,
            calendar.readOnly,
            calendar.supportsEvents,
          ],
        );
      }
      // Collections that vanished server-side must not linger in the cache.
      await client.query(
        `DELETE FROM caldav_calendars WHERE account_id = $1 AND NOT (url = ANY($2::text[]))`,
        [accountId, calendars.map((calendar) => calendar.url)],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async setCalendarEnabled(id: string, enabled: boolean): Promise<CalDavCalendarRow | null> {
    const { rows } = await this.pool.query(
      `UPDATE caldav_calendars SET enabled = $2 WHERE id = $1 RETURNING ${CALENDAR_COLUMNS}`,
      [id, enabled],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapCalendar(row) : null;
  }
}

function mapAccount(row: Record<string, unknown>): CalDavAccountRow {
  return {
    id: String(row["id"]),
    userId: String(row["user_id"]),
    name: String(row["name"]),
    baseUrl: String(row["base_url"]),
    username: String(row["username"]),
    passwordEnc: String(row["password_enc"]),
    timezone: String(row["timezone"]),
    enabled: Boolean(row["enabled"]),
  };
}

function mapCalendar(row: Record<string, unknown>): CalDavCalendarRow {
  return {
    id: String(row["id"]),
    accountId: String(row["account_id"]),
    url: String(row["url"]),
    displayName: String(row["display_name"]),
    ctag: (row["ctag"] as string | null) ?? null,
    color: (row["color"] as string | null) ?? null,
    readOnly: Boolean(row["read_only"]),
    supportsEvents: Boolean(row["supports_events"]),
    enabled: Boolean(row["enabled"]),
  };
}
