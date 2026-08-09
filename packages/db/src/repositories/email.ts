import type pg from "pg";

export type ImapMessageRoute = "none" | "telegram" | "discord" | "call";
export type ImapFallbackRoute = Exclude<ImapMessageRoute, "call">;
export type ImapReplyMode = "none" | "draft" | "ask";

export interface ImapDeliveryPolicy {
  low: ImapMessageRoute;
  normal: ImapMessageRoute;
  urgent: ImapMessageRoute;
  callFallback: ImapFallbackRoute;
  callRetryCount: number;
  callRetryDelayMinutes: number;
  replyMode: ImapReplyMode;
  instructions: string;
}

export const DEFAULT_IMAP_DELIVERY_POLICY: ImapDeliveryPolicy = {
  low: "none",
  normal: "telegram",
  urgent: "call",
  callFallback: "telegram",
  callRetryCount: 1,
  callRetryDelayMinutes: 20,
  replyMode: "draft",
  instructions: "",
};

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
  deliveryPolicy: ImapDeliveryPolicy;
  maxBodyChars: number;
  enabled: boolean;
}

export interface ImapDeliveryEventRow {
  id: string;
  accountId: string;
  messageId: string;
  userId: string;
  summary: string;
  replyDraft: string | null;
  fallbackChannel: ImapFallbackRoute;
  callContext: string;
  callId: string | null;
  callsAttempted: number;
  maxCallAttempts: number;
  retryDelayMinutes: number;
  retryAt: Date | null;
  state: "awaiting_call" | "retry_scheduled" | "delivered" | "fallback_sent";
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
                         mailbox, notify_channel, delivery_policy, max_body_chars, enabled`;
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
        (user_id, name, host, port, secure, username, password_enc, mailbox, notify_channel, delivery_policy, max_body_chars)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
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
        JSON.stringify(input.deliveryPolicy),
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
      ["notifyChannel", "notify_channel"], ["deliveryPolicy", "delivery_policy"], ["maxBodyChars", "max_body_chars"], ["enabled", "enabled"],
    ];
    const values: unknown[] = [id];
    const assignments: string[] = [];
    for (const [key, column] of mappings) {
      if (!(key in patch)) continue;
      values.push(key === "deliveryPolicy" ? JSON.stringify(patch[key]) : patch[key]);
      assignments.push(`${column} = $${values.length}${key === "deliveryPolicy" ? "::jsonb" : ""}`);
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

  /** Returns null when this UID was already mirrored, making reconnect retries harmless. */
  async insertMessage(input: Omit<ImapMessageRow, "id" | "createdAt">): Promise<ImapMessageRow | null> {
    const { rows } = await this.pool.query(
      `INSERT INTO imap_account_messages
         (account_id, uid_validity, uid, message_id, from_address, subject, received_at, body_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (account_id, uid_validity, uid) DO NOTHING
       RETURNING ${MESSAGE_COLUMNS}`,
      [input.accountId, input.uidValidity, input.uid, input.messageId, input.fromAddress, input.subject, input.receivedAt, input.bodyText],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapMessage(row) : null;
  }

  async createDeliveryEvent(input: Omit<ImapDeliveryEventRow, "id" | "callId" | "retryAt" | "state"> & { callId?: string | null }): Promise<ImapDeliveryEventRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO imap_delivery_events
        (account_id, message_id, user_id, summary, reply_draft, fallback_channel, call_context, call_id,
         calls_attempted, max_call_attempts, retry_delay_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [input.accountId, input.messageId, input.userId, input.summary, input.replyDraft, input.fallbackChannel,
        input.callContext, input.callId ?? null, input.callsAttempted, input.maxCallAttempts, input.retryDelayMinutes],
    );
    return mapDeliveryEvent(rows[0] as Record<string, unknown>);
  }

  async getDeliveryEventByCall(callId: string): Promise<ImapDeliveryEventRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM imap_delivery_events WHERE call_id = $1`, [callId]);
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapDeliveryEvent(row) : null;
  }

  async listDueDeliveryEvents(limit = 20): Promise<ImapDeliveryEventRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM imap_delivery_events WHERE state = 'retry_scheduled' AND retry_at <= now()
       ORDER BY retry_at LIMIT $1`,
      [limit],
    );
    return (rows as Array<Record<string, unknown>>).map(mapDeliveryEvent);
  }

  async listAwaitingDeliveryEvents(limit = 50): Promise<ImapDeliveryEventRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM imap_delivery_events WHERE state = 'awaiting_call' ORDER BY updated_at LIMIT $1`,
      [limit],
    );
    return (rows as Array<Record<string, unknown>>).map(mapDeliveryEvent);
  }

  async updateDeliveryEvent(
    id: string,
    patch: Partial<Pick<ImapDeliveryEventRow, "callId" | "callsAttempted" | "retryAt" | "state">>,
  ): Promise<void> {
    const columns: Array<[keyof typeof patch, string]> = [
      ["callId", "call_id"], ["callsAttempted", "calls_attempted"], ["retryAt", "retry_at"], ["state", "state"],
    ];
    const values: unknown[] = [id];
    const assignments: string[] = [];
    for (const [key, column] of columns) {
      if (!(key in patch)) continue;
      values.push(patch[key]);
      assignments.push(`${column} = $${values.length}`);
    }
    if (!assignments.length) return;
    await this.pool.query(
      `UPDATE imap_delivery_events SET ${assignments.join(", ")}, updated_at = now() WHERE id = $1`,
      values,
    );
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
    deliveryPolicy: parseDeliveryPolicy(row["delivery_policy"]),
    maxBodyChars: Number(row["max_body_chars"]), enabled: Boolean(row["enabled"]),
  };
}

function parseDeliveryPolicy(value: unknown): ImapDeliveryPolicy {
  const parsed = typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : value as Record<string, unknown> | null;
  const route = (candidate: unknown, fallback: ImapMessageRoute): ImapMessageRoute =>
    candidate === "none" || candidate === "telegram" || candidate === "discord" || candidate === "call" ? candidate : fallback;
  const fallback = (candidate: unknown): ImapFallbackRoute =>
    candidate === "none" || candidate === "telegram" || candidate === "discord" ? candidate : DEFAULT_IMAP_DELIVERY_POLICY.callFallback;
  const number = (candidate: unknown, defaultValue: number, maximum: number) =>
    typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0 && candidate <= maximum ? candidate : defaultValue;
  return {
    low: route(parsed?.["low"], DEFAULT_IMAP_DELIVERY_POLICY.low),
    normal: route(parsed?.["normal"], DEFAULT_IMAP_DELIVERY_POLICY.normal),
    urgent: route(parsed?.["urgent"], DEFAULT_IMAP_DELIVERY_POLICY.urgent),
    callFallback: fallback(parsed?.["callFallback"]),
    callRetryCount: number(parsed?.["callRetryCount"], DEFAULT_IMAP_DELIVERY_POLICY.callRetryCount, 4),
    callRetryDelayMinutes: number(parsed?.["callRetryDelayMinutes"], DEFAULT_IMAP_DELIVERY_POLICY.callRetryDelayMinutes, 1440),
    replyMode: parsed?.["replyMode"] === "none" || parsed?.["replyMode"] === "ask" || parsed?.["replyMode"] === "draft"
      ? parsed["replyMode"] : DEFAULT_IMAP_DELIVERY_POLICY.replyMode,
    instructions: typeof parsed?.["instructions"] === "string" ? parsed["instructions"].slice(0, 2000) : "",
  };
}

function mapDeliveryEvent(row: Record<string, unknown>): ImapDeliveryEventRow {
  return {
    id: String(row["id"]), accountId: String(row["account_id"]), messageId: String(row["message_id"]), userId: String(row["user_id"]),
    summary: String(row["summary"]), replyDraft: (row["reply_draft"] as string | null) ?? null,
    fallbackChannel: row["fallback_channel"] as ImapFallbackRoute, callContext: String(row["call_context"]),
    callId: (row["call_id"] as string | null) ?? null, callsAttempted: Number(row["calls_attempted"]),
    maxCallAttempts: Number(row["max_call_attempts"]), retryDelayMinutes: Number(row["retry_delay_minutes"]),
    retryAt: (row["retry_at"] as Date | null) ?? null, state: row["state"] as ImapDeliveryEventRow["state"],
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
