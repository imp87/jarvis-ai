import type { Logger } from "@jarvis/shared";

export interface ResolvedIdentity {
  userId: string;
  displayName: string;
  settings: { replyFormat: "text" | "voice"; voiceId: string | null; language: string };
}

export interface InboundResult {
  conversationId: string;
  reply: string;
  replyFormat: "text" | "voice";
  voiceId: string | null;
  language: string;
}

/**
 * Client for the orchestrator's channel-agnostic ingress. The adapter knows
 * exactly two endpoints: resolve an identity, and post a message.
 */
export class OrchestratorClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly serviceToken: string,
    private readonly logger: Logger,
    private readonly timeoutMs = 180_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Returns null for an unregistered identity. Called before any expensive work
   * so a stranger's voice note is never downloaded or transcribed.
   */
  async resolveIdentity(channelUserId: string): Promise<ResolvedIdentity | null> {
    const url = new URL(`${this.baseUrl}/v1/identities/resolve`);
    url.searchParams.set("channel", "telegram");
    url.searchParams.set("channelUserId", channelUserId);

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.serviceToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`identity resolve failed: ${response.status} ${await safeText(response)}`);
    }
    return (await response.json()) as ResolvedIdentity;
  }

  async sendInbound(input: {
    channelUserId: string;
    text: string;
    metadata: Record<string, unknown>;
  }): Promise<InboundResult> {
    const response = await fetch(`${this.baseUrl}/v1/messages/inbound`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        channelUserId: input.channelUserId,
        text: input.text,
        metadata: input.metadata,
      }),
      // The agent loop can run tools for a while; this is deliberately generous.
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await safeText(response);
      this.logger.error({ status: response.status, body }, "orchestrator rejected inbound message");
      throw new Error(`orchestrator returned ${response.status}`);
    }
    return (await response.json()) as InboundResult;
  }
}

async function safeText(response: Response): Promise<string> {
  return (await response.text().catch(() => "")).slice(0, 500);
}
