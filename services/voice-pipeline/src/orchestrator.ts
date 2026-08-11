import { tryNormalisePhoneNumber, type Logger } from "@jarvis/shared";

export interface ResolvedCaller {
  userId: string;
  displayName: string;
}

export interface ReplyResult {
  conversationId: string;
  reply: string;
  /**
   * Set when the agent called `end_call`. The reply is still spoken first —
   * this asks for the line to close afterwards, not instead.
   */
  endCall?: { reason: string } | null;
}

/**
 * The pipeline's view of the orchestrator: authorise a number, and exchange a
 * turn. Identical shape to the Telegram adapter's client, because from the
 * orchestrator's side a phone call is just another channel.
 */
export class OrchestratorClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly serviceToken: string,
    private readonly logger: Logger,
    private readonly timeoutMs = 120_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * The caller allowlist. A number is authorised only if it is registered as a
   * `voice_call` identity and enabled — the same gate Telegram uses, so
   * revoking access in one place covers every channel.
   *
   * Returns null for withheld, unparseable or unregistered numbers. Anonymous
   * callers are rejected by construction: no number, no match.
   */
  async authoriseCaller(rawNumber: string | null): Promise<ResolvedCaller | null> {
    if (!rawNumber) return null;
    const number = tryNormalisePhoneNumber(rawNumber);
    if (!number) {
      this.logger.warn({ raw: rawNumber.slice(0, 6) }, "caller ID could not be normalised");
      return null;
    }

    const url = new URL(`${this.baseUrl}/v1/identities/resolve`);
    url.searchParams.set("channel", "voice_call");
    url.searchParams.set("channelUserId", number);

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.serviceToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`identity resolve failed: ${response.status}`);
    }
    const body = (await response.json()) as ResolvedCaller;
    return { userId: body.userId, displayName: body.displayName };
  }

  /**
   * Tells the orchestrator how a call actually ended.
   *
   * Placing a call is fire-and-forget — a call file is written and Asterisk
   * dials it minutes later, or not at all. Without this the log would keep
   * saying `dialing` for a call that never rang, and because the call budget
   * counts `dialing`, every failure would silently consume one of the day's
   * allowance for good.
   *
   * Best-effort by design: a failed status report must never take down the
   * call handling it is reporting on.
   */
  async reportCallStatus(
    callId: string,
    status: "in_progress" | "completed" | "failed",
    error?: string,
  ): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/calls/${callId}/status`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${this.serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status, ...(error ? { error } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        this.logger.warn(
          { callId, status, http: response.status },
          "orchestrator rejected the call status report",
        );
      }
    } catch (err) {
      this.logger.warn({ callId, status, err: String(err) }, "could not report call status");
    }
  }

  /**
   * A spoken turn inside a call we placed to somebody who is not the owner.
   *
   * Deliberately not `send()`. That posts to the inbound path, which asks the
   * identity allowlist whether the speaker may talk to Jarvis — a question a
   * hairdresser can never answer yes to, which is why every third-party turn
   * came back 403. Here the call id carries the authority instead.
   */
  async sendCallTurn(input: {
    callId: string;
    text: string;
    conversationId?: string;
  }): Promise<ReplyResult> {
    const response = await fetch(`${this.baseUrl}/v1/calls/${input.callId}/turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: input.text,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`orchestrator returned ${response.status}`);
    }
    return (await response.json()) as ReplyResult;
  }

  async send(input: {
    /** The caller's normalised E.164 number — the orchestrator keys on this. */
    channelUserId: string;
    text: string;
    conversationId?: string;
  }): Promise<ReplyResult> {
    const response = await fetch(`${this.baseUrl}/v1/messages/inbound`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channel: "voice_call",
        channelUserId: input.channelUserId,
        text: input.text,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`orchestrator returned ${response.status}`);
    }
    return (await response.json()) as ReplyResult;
  }
}
