import type pg from "pg";
import type { ChannelName } from "@jarvis/shared";

export interface UserRow {
  id: string;
  displayName: string;
  isOwner: boolean;
}

export class IdentityRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * The authentication check for every chat channel: an unregistered or
   * disabled identity resolves to null and the request is rejected. There is
   * no "create user on first contact" path — registration is deliberate.
   */
  async findUserByChannelIdentity(
    channel: ChannelName,
    channelUserId: string,
  ): Promise<UserRow | null> {
    const { rows } = await this.pool.query<{
      id: string;
      display_name: string;
      is_owner: boolean;
    }>(
      `SELECT u.id, u.display_name, u.is_owner
         FROM identities i
         JOIN users u ON u.id = i.user_id
        WHERE i.channel = $1 AND i.channel_user_id = $2 AND i.enabled = true`,
      [channel, channelUserId],
    );
    const row = rows[0];
    return row
      ? { id: row.id, displayName: row.display_name, isOwner: row.is_owner }
      : null;
  }

  async createUser(displayName: string, isOwner = false): Promise<UserRow> {
    const { rows } = await this.pool.query<{
      id: string;
      display_name: string;
      is_owner: boolean;
    }>(
      `INSERT INTO users (display_name, is_owner) VALUES ($1, $2)
       RETURNING id, display_name, is_owner`,
      [displayName, isOwner],
    );
    const row = rows[0]!;
    return { id: row.id, displayName: row.display_name, isOwner: row.is_owner };
  }

  async linkIdentity(
    userId: string,
    channel: ChannelName,
    channelUserId: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO identities (user_id, channel, channel_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (channel, channel_user_id)
       DO UPDATE SET user_id = EXCLUDED.user_id, enabled = true`,
      [userId, channel, channelUserId],
    );
  }

  async setIdentityEnabled(
    channel: ChannelName,
    channelUserId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE identities SET enabled = $3 WHERE channel = $1 AND channel_user_id = $2`,
      [channel, channelUserId, enabled],
    );
  }

  async listUsers(): Promise<UserRow[]> {
    const { rows } = await this.pool.query<{
      id: string;
      display_name: string;
      is_owner: boolean;
    }>(
      // Owner first: on a personal system that is nearly always the row you want.
      `SELECT id, display_name, is_owner FROM users ORDER BY is_owner DESC, display_name`,
    );
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, isOwner: r.is_owner }));
  }

  async listIdentities(): Promise<
    Array<{ channel: string; channelUserId: string; enabled: boolean; userId: string }>
  > {
    const { rows } = await this.pool.query<{
      channel: string;
      channel_user_id: string;
      enabled: boolean;
      user_id: string;
    }>(
      `SELECT channel, channel_user_id, enabled, user_id FROM identities ORDER BY channel, channel_user_id`,
    );
    return rows.map((r) => ({
      channel: r.channel,
      channelUserId: r.channel_user_id,
      enabled: r.enabled,
      userId: r.user_id,
    }));
  }
}
