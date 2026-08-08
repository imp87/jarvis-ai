import type pg from "pg";
import type { ChannelName, ContentBlock, LlmMessage } from "@jarvis/shared";

export interface ConversationRow {
  id: string;
  userId: string;
  title: string | null;
  lastActiveAt: Date;
}

export interface PersistMessageInput {
  conversationId: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  providerEcho?: { provider: string; blocks: unknown };
  channel?: ChannelName;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export class ConversationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(userId: string, title?: string): Promise<ConversationRow> {
    const { rows } = await this.pool.query<{
      id: string;
      user_id: string;
      title: string | null;
      last_active_at: Date;
    }>(
      `INSERT INTO conversations (user_id, title) VALUES ($1, $2)
       RETURNING id, user_id, title, last_active_at`,
      [userId, title ?? null],
    );
    const row = rows[0]!;
    return {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      lastActiveAt: row.last_active_at,
    };
  }

  async findById(id: string, userId: string): Promise<ConversationRow | null> {
    const { rows } = await this.pool.query<{
      id: string;
      user_id: string;
      title: string | null;
      last_active_at: Date;
    }>(
      `SELECT id, user_id, title, last_active_at
         FROM conversations WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    const row = rows[0];
    return row
      ? { id: row.id, userId: row.user_id, title: row.title, lastActiveAt: row.last_active_at }
      : null;
  }

  /**
   * Cross-channel continuity: a message with no explicit conversationId
   * continues the user's most recent thread if it is still fresh, otherwise
   * starts a new one. `idleMinutes` is the "this is a new topic" cutoff.
   */
  async findOrCreateActive(userId: string, idleMinutes = 180): Promise<ConversationRow> {
    const { rows } = await this.pool.query<{
      id: string;
      user_id: string;
      title: string | null;
      last_active_at: Date;
    }>(
      `SELECT id, user_id, title, last_active_at
         FROM conversations
        WHERE user_id = $1 AND last_active_at > now() - ($2 || ' minutes')::interval
        ORDER BY last_active_at DESC
        LIMIT 1`,
      [userId, String(idleMinutes)],
    );
    const row = rows[0];
    if (row) {
      return {
        id: row.id,
        userId: row.user_id,
        title: row.title,
        lastActiveAt: row.last_active_at,
      };
    }
    return this.create(userId);
  }

  async touch(conversationId: string): Promise<void> {
    await this.pool.query(
      `UPDATE conversations SET last_active_at = now() WHERE id = $1`,
      [conversationId],
    );
  }

  async setTitle(conversationId: string, title: string): Promise<void> {
    await this.pool.query(`UPDATE conversations SET title = $2 WHERE id = $1`, [
      conversationId,
      title,
    ]);
  }

  async appendMessage(input: PersistMessageInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages
         (conversation_id, role, content, provider_echo, channel, provider, model,
          input_tokens, output_tokens)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9)`,
      [
        input.conversationId,
        input.role,
        JSON.stringify(input.content),
        input.providerEcho ? JSON.stringify(input.providerEcho) : null,
        input.channel ?? null,
        input.provider ?? null,
        input.model ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
      ],
    );
    await this.touch(input.conversationId);
  }

  /** Most recent `limit` messages, returned oldest-first for the LLM. */
  async recentMessages(conversationId: string, limit = 40): Promise<LlmMessage[]> {
    const { rows } = await this.pool.query<{
      role: "user" | "assistant";
      content: ContentBlock[];
      provider_echo: { provider: string; blocks: unknown } | null;
    }>(
      `SELECT role, content, provider_echo FROM (
         SELECT role, content, provider_echo, id
           FROM messages
          WHERE conversation_id = $1
          ORDER BY id DESC
          LIMIT $2
       ) recent ORDER BY id ASC`,
      [conversationId, limit],
    );
    return rows.map((r) => ({
      role: r.role,
      content: r.content,
      ...(r.provider_echo ? { providerEcho: r.provider_echo } : {}),
    }));
  }

  async listForUser(userId: string, limit = 50): Promise<ConversationRow[]> {
    const { rows } = await this.pool.query<{
      id: string;
      user_id: string;
      title: string | null;
      last_active_at: Date;
    }>(
      `SELECT id, user_id, title, last_active_at
         FROM conversations WHERE user_id = $1
        ORDER BY last_active_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      title: r.title,
      lastActiveAt: r.last_active_at,
    }));
  }
}
