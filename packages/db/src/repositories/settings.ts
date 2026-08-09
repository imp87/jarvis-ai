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

/**
 * Runtime policy overrides. `null` means "no override — use the environment",
 * which is what lets the settings UI show where a value actually comes from
 * and offer to hand it back.
 */
export interface RuntimePolicyOverrides {
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursTimezone: string | null;
  maxCallsPerHour: number | null;
  maxCallsPerDay: number | null;
  updatedAt: Date | null;
}

export const NO_OVERRIDES: RuntimePolicyOverrides = {
  quietHoursStart: null,
  quietHoursEnd: null,
  quietHoursTimezone: null,
  maxCallsPerHour: null,
  maxCallsPerDay: null,
  updatedAt: null,
};

export class SettingsRepository {
  constructor(private readonly pool: pg.Pool) {}

  // --- Global runtime policy ------------------------------------------------

  async getRuntimePolicy(): Promise<RuntimePolicyOverrides> {
    const { rows } = await this.pool.query<{
      quiet_hours_start: string | null;
      quiet_hours_end: string | null;
      quiet_hours_timezone: string | null;
      max_calls_per_hour: number | null;
      max_calls_per_day: number | null;
      updated_at: Date;
    }>(
      `SELECT quiet_hours_start, quiet_hours_end, quiet_hours_timezone,
              max_calls_per_hour, max_calls_per_day, updated_at
         FROM runtime_settings WHERE id = true`,
    );
    const row = rows[0];
    if (!row) return { ...NO_OVERRIDES };
    return {
      quietHoursStart: row.quiet_hours_start,
      quietHoursEnd: row.quiet_hours_end,
      quietHoursTimezone: row.quiet_hours_timezone,
      maxCallsPerHour: row.max_calls_per_hour === null ? null : Number(row.max_calls_per_hour),
      maxCallsPerDay: row.max_calls_per_day === null ? null : Number(row.max_calls_per_day),
      updatedAt: row.updated_at,
    };
  }

  /**
   * Applies only the keys present in `patch`. An explicit `null` clears the
   * override and returns that setting to the environment value — which is a
   * different intent from "leave it as it is", and the reason this cannot be a
   * plain COALESCE.
   */
  async updateRuntimePolicy(
    patch: Partial<Omit<RuntimePolicyOverrides, "updatedAt">>,
  ): Promise<RuntimePolicyOverrides> {
    type Key = keyof Omit<RuntimePolicyOverrides, "updatedAt">;
    // Column names come from this fixed map, never from the caller — the
    // assignment list is interpolated into the SQL and values are bound.
    const columns: Array<[Key, string]> = [
      ["quietHoursStart", "quiet_hours_start"],
      ["quietHoursEnd", "quiet_hours_end"],
      ["quietHoursTimezone", "quiet_hours_timezone"],
      ["maxCallsPerHour", "max_calls_per_hour"],
      ["maxCallsPerDay", "max_calls_per_day"],
    ];

    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of columns) {
      if (!(key in patch)) continue;
      values.push(patch[key] ?? null);
      assignments.push(`${column} = $${values.length}`);
    }
    if (assignments.length === 0) return this.getRuntimePolicy();

    await this.pool.query(
      `UPDATE runtime_settings SET ${assignments.join(", ")}, updated_at = now() WHERE id = true`,
      values,
    );
    return this.getRuntimePolicy();
  }

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
