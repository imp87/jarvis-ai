import type pg from "pg";
import type { ChannelName } from "@jarvis/shared";

export type ReplyFormat = "text" | "voice";

export interface ChannelSettings {
  replyFormat: ReplyFormat;
  voiceId: string | null;
  language: string;
}

export const DEFAULT_CHANNEL_SETTINGS: ChannelSettings = {
  replyFormat: "text",
  voiceId: null,
  language: "de",
};

export class SettingsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Never returns null: an unconfigured channel falls back to the defaults so
   * a new adapter works before anyone has opened the settings UI.
   */
  async get(userId: string, channel: ChannelName): Promise<ChannelSettings> {
    const { rows } = await this.pool.query<{
      reply_format: ReplyFormat;
      voice_id: string | null;
      language: string;
    }>(
      `SELECT reply_format, voice_id, language
         FROM user_channel_settings WHERE user_id = $1 AND channel = $2`,
      [userId, channel],
    );
    const row = rows[0];
    if (!row) return { ...DEFAULT_CHANNEL_SETTINGS };
    return {
      replyFormat: row.reply_format,
      voiceId: row.voice_id,
      language: row.language,
    };
  }

  async upsert(
    userId: string,
    channel: ChannelName,
    patch: Partial<ChannelSettings>,
  ): Promise<ChannelSettings> {
    const current = await this.get(userId, channel);
    const next: ChannelSettings = { ...current, ...patch };
    await this.pool.query(
      `INSERT INTO user_channel_settings (user_id, channel, reply_format, voice_id, language)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, channel) DO UPDATE
         SET reply_format = EXCLUDED.reply_format,
             voice_id     = EXCLUDED.voice_id,
             language     = EXCLUDED.language,
             updated_at   = now()`,
      [userId, channel, next.replyFormat, next.voiceId, next.language],
    );
    return next;
  }

  async listForUser(
    userId: string,
  ): Promise<Array<ChannelSettings & { channel: string }>> {
    const { rows } = await this.pool.query<{
      channel: string;
      reply_format: ReplyFormat;
      voice_id: string | null;
      language: string;
    }>(
      `SELECT channel, reply_format, voice_id, language
         FROM user_channel_settings WHERE user_id = $1 ORDER BY channel`,
      [userId],
    );
    return rows.map((r) => ({
      channel: r.channel,
      replyFormat: r.reply_format,
      voiceId: r.voice_id,
      language: r.language,
    }));
  }
}
