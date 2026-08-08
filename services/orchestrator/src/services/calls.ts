import type { CallRepository, CallLogRow } from "@jarvis/db";
import {
  evaluateCallPolicy,
  type CallRequest,
  type Logger,
  type QuietHours,
} from "@jarvis/shared";

export interface CallServiceOptions {
  quietHours: QuietHours;
  maxPerHour: number;
  maxPerDay: number;
  /** Voice pipeline base URL. When absent, calls are recorded but not placed. */
  voicePipelineUrl?: string | undefined;
  serviceToken: string;
}

export type CallOutcome =
  | { placed: true; call: CallLogRow }
  | { placed: false; call: CallLogRow; reason: string };

/**
 * Everything that can dial your phone goes through here (component 1's trigger
 * side). The policy check runs before the provider is touched, so a
 * false-positive storm from the email classifier costs nothing and wakes
 * nobody: blocked attempts are logged with a reason and do not consume budget.
 */
export class CallService {
  constructor(
    private readonly repo: CallRepository,
    private readonly options: CallServiceOptions,
    private readonly logger: Logger,
  ) {}

  async requestCall(request: CallRequest): Promise<CallOutcome> {
    const usage = await this.repo.budgetUsage();
    const decision = evaluateCallPolicy({
      now: new Date(),
      urgent: request.urgent,
      quiet: this.options.quietHours,
      budget: { maxPerHour: this.options.maxPerHour, maxPerDay: this.options.maxPerDay },
      usage,
    });

    if (!decision.allowed) {
      const call = await this.repo.record({
        conversationId: request.conversationId ?? null,
        toNumber: request.toNumber,
        reason: request.reason,
        status: "blocked",
        blockedReason: decision.reason,
      });
      this.logger.info(
        { reason: decision.reason, to: maskNumber(request.toNumber), usage },
        "outbound call blocked by policy",
      );
      return { placed: false, call, reason: decision.reason };
    }

    const call = await this.repo.record({
      conversationId: request.conversationId ?? null,
      toNumber: request.toNumber,
      reason: request.reason,
      status: "requested",
    });

    if (!this.options.voicePipelineUrl) {
      // Component 1 is not wired up yet. Record the intent so the behaviour is
      // observable end-to-end, and make the gap explicit rather than pretending
      // the call happened.
      this.logger.warn(
        { callId: call.id },
        "no VOICE_PIPELINE_URL configured; call recorded but not placed",
      );
      return { placed: false, call, reason: "voice pipeline not configured" };
    }

    try {
      const response = await fetch(`${this.options.voicePipelineUrl}/v1/calls`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.serviceToken}`,
        },
        body: JSON.stringify({
          callId: call.id,
          toNumber: request.toNumber,
          context: request.context,
          reason: request.reason,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`voice pipeline ${response.status}: ${text.slice(0, 300)}`);
      }
      const payload = (await response.json()) as { providerCallId?: string };
      await this.repo.updateStatus(call.id, "dialing", {
        ...(payload.providerCallId ? { providerCallId: payload.providerCallId } : {}),
        startedAt: new Date(),
      });
      return { placed: true, call };
    } catch (err) {
      await this.repo.updateStatus(call.id, "failed");
      this.logger.error({ err: String(err), callId: call.id }, "failed to place call");
      return { placed: false, call, reason: `call failed: ${(err as Error).message}` };
    }
  }
}

/** Never write a full phone number into a log line. */
function maskNumber(value: string): string {
  return value.length <= 5 ? "***" : `${value.slice(0, 4)}***${value.slice(-2)}`;
}
