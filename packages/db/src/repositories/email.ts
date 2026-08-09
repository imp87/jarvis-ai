import type pg from "pg";

export interface ImapAccountRow {
  id: string;
  userId: string;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  /** AES-GCM envelope. It never leaves the orchestrator. */
  passwordEnc: string;
  mailbox: string;
  notifyChannel: "telegram" | "discord";
  maxBodyChars: number;
  enabled: boolean;
}

export interface ImapCursorRow {
  accountId: string;
  uidValidity: string;
  lastUid: number;
}

export interface ImapMessageRow {
  id: string;
  accountId: string;
  uidValidity: string;
  uid: number;
  messageId: string | null;
  fromAddress: string;
  subject: string;
  receivedAt: Date;
  bodyText: string;
  createdAt: Date;
}

const ACCOUNT_COLUMNS = `id, user_id, name, host, port, secure, username, password_enc,
                         mailbox, notify_channel, max_body_chars, enabled`;
const MESSAGE_COLUMNS = `id, account_id, uid_validity, uid, message_id, from_address,
                         subject, received_at, body_text, created_at`;

/** IMAP account registry, persistent UID cursors, and a local mailbox mirror. */
export class EmailRepository {
  constructor(private readonly pool: pg.Pool) {}

  async listAccounts(onlyEnabled = false): Promise<ImapAccountRow[]> {
    const { rows } = await this.pool.query(
      `SELECT ${ACCOUNT_COLUMNS} FROM imap_accounts
        WHERE ($1::boolean = false OR enabled = true)
        ORDER BY name`,
      [onlyEnabled],
    );
    return (rows as Array<Record<string, unknown>>).map(mapAccount);
  }

  async getAccount(id: string): Promise<ImapAccountRow | null> {
    const { rows } = await this.pool.query(`SELECT ${ACCOUNT_COLUMNS} FROM imap_accounts WHERE id = $1`, [id]);
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapAccount(row) : null;
  }

  async createAccount(input: Omit<ImapAccountRow, "id" | "enabled">): Promise<ImapAccountRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO imap_accounts
        (user_id, name, host, port, secure, username, password_enc, mailbox, notify_channel, max_body_chars)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${ACCOUNT_COLUMNS}`,
      [
        input.userId,
        input.name,
        input.host,
        input.port,
        input.secure,
        input.username,
        input.passwordEnc,
        input.mailbox,
        input.notifyChannel,
        input.maxBodyChars,
      ],
    );
    return mapAccount(rows[0] as Record<string, unknown>);
  }

  async updateAccount(
    id: string,
    patch: Partial<Omit<ImapAccountRow, "id" | "userId" | "enabled">> & { enabled?: boolean },
  ): Promise<ImapAccountRow | null> {
    const mappings: Array<[keyof typeof patch, string]> = [
      ["name", "name"], ["host", "host"], ["port", "port"], ["secure", "secure"],
      ["username", "username"], ["passwordEnc", "password_enc"], ["mailbox", "mailbox"],
      ["notifyChannel", "notify_channel"], ["maxBodyChars", "max_body_chars"], ["enabled", "enabled"],
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
      `UPDATE imap_accounts SET ${assignments.join(", ")}, updated_at = now()
        WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
      values,
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapAccount(row) : null;
  }

  async deleteAccount(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM imap_accounts WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async getCursor(accountId: string): Promise<ImapCursorRow | null> {
    const { rows } = await this.pool.query(
      `SELECT account_id, uid_validity, last_uid FROM imap_account_cursors WHERE account_id = $1`,
      [accountId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row
      ? { accountId: String(row["account_id"]), uidValidity: String(row["uid_validity"]), lastUid: Number(row["last_uid"]) }
      : null;
  }

  async setCursor(input: ImapCursorRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO imap_account_cursors (account_id, uid_validity, last_uid)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET
         uid_validity = EXCLUDED.uid_validity, last_uid = EXCLUDED.last_uid, updated_at = now()`,
      [input.accountId, input.uidValidity, input.lastUid],
    );
  }

  /** Returns false when this UID was already mirrored, making reconnect retries harmless. */
  async insertMessage(input: Omit<ImapMessageRow, "id" | "createdAt">): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO imap_account_messages
         (account_id, uid_validity, uid, message_id, from_address, subject, received_at, body_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (account_id, uid_validity, uid) DO NOTHING`,
      [input.accountId, input.uidValidity, input.uid, input.messageId, input.fromAddress, input.subject, input.receivedAt, input.bodyText],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async searchMessages(input: { userId: string; query?: string; limit: number }): Promise<ImapMessageRow[]> {
    const query = input.query?.trim() ?? "";
    const { rows } = await this.pool.query(
      `SELECT m.${MESSAGE_COLUMNS.replaceAll(", ", ", m.")} FROM imap_account_messages m
        JOIN imap_accounts a ON a.id = m.account_id
       WHERE a.user_id = $1
         AND ($2 = '' OR m.from_address ILIKE '%' || $2 || '%' OR m.subject ILIKE '%' || $2 || '%'
              OR m.body_text ILIKE '%' || $2 || '%')
       ORDER BY m.received_at DESC LIMIT $3`,
      [input.userId, query, input.limit],
    );
    return (rows as Array<Record<string, unknown>>).map(mapMessage);
  }

  async getMessage(userId: string, id: string): Promise<ImapMessageRow | null> {
    const { rows } = await this.pool.query(
      `SELECT m.${MESSAGE_COLUMNS.replaceAll(", ", ", m.")} FROM imap_account_messages m
        JOIN imap_accounts a ON a.id = m.account_id
       WHERE m.id = $1 AND a.user_id = $2`,
      [id, userId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapMessage(row) : null;
  }
}

function mapAccount(row: Record<string, unknown>): ImapAccountRow {
  return {
    id: String(row["id"]), userId: String(row["user_id"]), name: String(row["name"]),
    host: String(row["host"]), port: Number(row["port"]), secure: Boolean(row["secure"]),
    username: String(row["username"]), passwordEnc: String(row["password_enc"]),
    mailbox: String(row["mailbox"]), notifyChannel: row["notify_channel"] as "telegram" | "discord",
    maxBodyChars: Number(row["max_body_chars"]), enabled: Boolean(row["enabled"]),
  };
}

function mapMessage(row: Record<string, unknown>): ImapMessageRow {
  return {
    id: String(row["id"]), accountId: String(row["account_id"]), uidValidity: String(row["uid_validity"]),
    uid: Number(row["uid"]), messageId: (row["message_id"] as string | null) ?? null,
    fromAddress: String(row["from_address"]), subject: String(row["subject"]),
    receivedAt: row["received_at"] as Date, bodyText: String(row["body_text"]), createdAt: row["created_at"] as Date,
  };
}
