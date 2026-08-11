import type { CallRepository, CallLogRow } from "@jarvis/db";
import {
  evaluateCallPolicy,
  selectCallBudget,
  type CallClass,
  type CallRequest,
  type Logger,
} from "@jarvis/shared";
import type { PolicyService } from "./policy.js";

export interface CallServiceOptions {
  /** Voice pipeline base URL. When absent, calls are recorded but not placed. */
  voicePipelineUrl?: string | undefined;
  serviceToken: string;
  /** Used only to tell the owner's own number from everyone else's. */
  ownerPhoneNumber?: string | undefined;
  /**
   * Allowance for the orchestrator's own alarms, separate from the agent's.
   *
   * Deliberately small. It has to survive a day of reminders having spent the
   * ordinary budget, but an alarm that can repeat without limit is itself a way
   * to be dialled all night.
   */
  systemAlertBudget: { maxPerHour: number; maxPerDay: number };
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
    private readonly policy: PolicyService,
    private readonly options: CallServiceOptions,
    private readonly logger: Logger,
  ) {}

  /**
   * @param callClass Which allowance to draw on. `system_alert` is reserved for
   * the orchestrator reporting its own failure and is never reachable from a
   * tool, so the model cannot route itself onto the channel that ignores quiet
   * hours.
   */
  async requestCall(request: CallRequest, callClass: CallClass = "normal"): Promise<CallOutcome> {
    // Resolved per request: quiet hours edited in the admin UI must apply to the
    // very next call, not after a restart.
    const [usage, policy] = await Promise.all([
      this.repo.budgetUsage(callClass),
      this.policy.resolve(),
    ]);
    // Paired through the helper rather than by hand: checking an alarm against
    // the budget the reminders have already spent is the failure this split
    // exists to prevent.
    const budget = selectCallBudget(callClass, {
      normal: { maxPerHour: policy.maxCallsPerHour, maxPerDay: policy.maxCallsPerDay },
      systemAlert: this.options.systemAlertBudget,
    });
    const decision = evaluateCallPolicy({
      now: new Date(),
      urgent: request.urgent,
      quiet: policy.quietHours,
      budget,
      usage,
      callClass,
    });

    if (!decision.allowed) {
      const call = await this.repo.record({
        conversationId: request.conversationId ?? null,
        toNumber: request.toNumber,
        reason: request.reason,
        status: "blocked",
        blockedReason: decision.reason,
        kind: callClass,
      });
      this.logger.info(
        {
          reason: decision.reason,
          to: maskNumber(request.toNumber),
          callClass,
          usage,
          // Which limits were actually in force, and whether they came from the
          // database or the environment. Without this, "the limit is 0 but it
          // says 8" is only answerable by hand.
          limits: {
            perHour: budget.maxPerHour,
            perDay: budget.maxPerDay,
            quietHours: policy.quietHours,
          },
          source: policy.overridden,
        },
        "outbound call blocked by policy",
      );
      return { placed: false, call, reason: decision.reason };
    }

    const call = await this.repo.record({
      conversationId: request.conversationId ?? null,
      toNumber: request.toNumber,
      reason: request.reason,
      status: "requested",
      kind: callClass,
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
          // The pipeline cannot work this out: it never learns the owner's own
          // number. It decides the persona and the delegation route from this.
          counterpart:
            this.options.ownerPhoneNumber && request.toNumber === this.options.ownerPhoneNumber
              ? "owner"
              : "third_party",
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
