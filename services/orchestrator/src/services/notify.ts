import type { IdentityRepository } from "@jarvis/db";
import type { ChannelName, Logger } from "@jarvis/shared";

/**
 * Speaking first.
 *
 * Every other path in this system is a reply: something arrives, the agent
 * answers. Scheduled work needs the other direction, and so does anything that
 * notices something matters while nobody is looking. The orchestrator still
 * knows nothing about Telegram — it resolves the user's identity for a channel
 * and hands the text to that channel's adapter.
 */

export interface NotifyResult {
  delivered: boolean;
  channel: ChannelName;
  reason?: string;
}

export class NotificationService {
  constructor(
    private readonly identities: IdentityRepository,
    private readonly adapters: Partial<Record<ChannelName, string>>,
    private readonly serviceToken: string,
    private readonly logger: Logger,
  ) {}

  /** Channels that can currently be pushed to, for tool descriptions and the UI. */
  availableChannels(): ChannelName[] {
    return Object.entries(this.adapters)
      .filter(([, url]) => Boolean(url))
      .map(([channel]) => channel as ChannelName);
  }

  async send(userId: string, channel: ChannelName, text: string): Promise<NotifyResult> {
    const baseUrl = this.adapters[channel];
    if (!baseUrl) {
      // Loud on purpose. A channel that is selectable in the admin UI but has
      // no adapter behind it drops every message it is given, and returning a
      // quiet `false` is what made that invisible: the IMAP delivery policy
      // offers Discord, nothing is wired to it, and the mail simply vanished.
      this.logger.warn(
        { channel, userId },
        "notification dropped: no adapter is configured for this channel",
      );
      return { delivered: false, channel, reason: `no adapter configured for ${channel}` };
    }

    // The same allowlist the inbound path uses: a disabled identity must not be
    // reachable in either direction.
    const identity = await this.identities.findEnabledIdentity(userId, channel);
    if (!identity) {
      return {
        delivered: false,
        channel,
        reason: `no enabled ${channel} identity for this user`,
      };
    }

    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/outbound`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.serviceToken}`,
        },
        body: JSON.stringify({ channelUserId: identity, text }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`${response.status}: ${body.slice(0, 200)}`);
      }
      this.logger.info({ channel, userId, chars: text.length }, "proactive message sent");
      return { delivered: true, channel };
    } catch (err) {
      this.logger.error({ channel, userId, err: String(err) }, "proactive delivery failed");
      return { delivered: false, channel, reason: (err as Error).message };
    }
  }
}
