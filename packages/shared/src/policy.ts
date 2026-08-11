/**
 * Pure policy helpers. No DB, no clock injection magic — the caller passes
 * `now` so this is trivially testable and deterministic.
 */

export interface QuietHours {
  /** "HH:MM" local time in `timezone`. */
  start: string;
  end: string;
  timezone: string;
}

function minutesInZone(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function parseHHMM(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Quiet hours normally wrap midnight (22:00 -> 07:00), so a naive
 * `start <= now <= end` comparison is wrong. Handle both orientations.
 */
export function isWithinQuietHours(now: Date, quiet: QuietHours): boolean {
  const current = minutesInZone(now, quiet.timezone);
  const start = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  if (start === end) return false;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

export interface CallBudget {
  /** 0 means no limit. */
  maxPerHour: number;
  /** 0 means no limit. */
  maxPerDay: number;
}

/**
 * Which budget a call draws on, and whether quiet hours apply to it.
 *
 * `normal` is every call the agent or the operator asks for: reminders, the
 * email classifier, `place_phone_call`. Quiet hours apply unless the call is
 * marked urgent, and urgency is never the model's to declare.
 *
 * `system_alert` is the orchestrator reporting its own failure — specifically
 * the case where an external commitment already exists and the local record of
 * it does not. The appointment is in someone else's book; not knowing about it
 * means missing it, so this one wakes you.
 *
 * They exist as separate classes because they were sharing one counter, and a
 * shared counter means a day of routine reminders can silently consume the
 * emergency channel — the budget would be exhausted exactly on the busy days
 * when a failure is most likely. The purpose of the budget is to stop a storm,
 * not to stop an alarm, so each class gets its own small allowance.
 */
export type CallClass = "normal" | "system_alert";

export interface CallBudgetUsage {
  lastHour: number;
  lastDay: number;
}

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string; retryAfterSeconds?: number };

export function evaluateCallPolicy(input: {
  now: Date;
  urgent: boolean;
  quiet: QuietHours;
  /**
   * The budget for `callClass`, not the global one. `selectCallBudget` pairs
   * the two correctly; passing a mismatched pair enforces the wrong limit.
   */
  budget: CallBudget;
  /** Usage for `callClass`, counted over the same class only. */
  usage: CallBudgetUsage;
  /** Defaults to `normal`, so existing callers keep their behaviour. */
  callClass?: CallClass;
}): PolicyDecision {
  const { now, urgent, quiet, budget, usage } = input;
  const callClass = input.callClass ?? "normal";

  // Budget applies even to urgent calls — the whole point is that a
  // false-positive storm can't dial you 40 times. It applies to system alerts
  // too, on their own smaller allowance: an alarm that can repeat without limit
  // is itself a way to be dialled all night.
  //
  // 0 disables the limit rather than blocking everything. The literal reading
  // ("allow zero calls") would turn a config meant to remove a restriction into
  // one that silently disables calling altogether; to stop the agent calling,
  // disable the voice_call identity or unset OWNER_PHONE_NUMBER instead.
  if (budget.maxPerHour > 0 && usage.lastHour >= budget.maxPerHour) {
    return {
      allowed: false,
      reason: `hourly call budget exhausted (${usage.lastHour}/${budget.maxPerHour})`,
      retryAfterSeconds: 3600,
    };
  }
  if (budget.maxPerDay > 0 && usage.lastDay >= budget.maxPerDay) {
    return {
      allowed: false,
      reason: `daily call budget exhausted (${usage.lastDay}/${budget.maxPerDay})`,
      retryAfterSeconds: 86_400,
    };
  }
  // A system alert passes quiet hours by construction, not by being marked
  // urgent: the model has no route to this class at all, so there is nothing
  // here for it to talk its way past.
  const mayWakeYou = urgent || callClass === "system_alert";
  if (!mayWakeYou && isWithinQuietHours(now, quiet)) {
    return {
      allowed: false,
      reason: `quiet hours active (${quiet.start}-${quiet.end} ${quiet.timezone})`,
    };
  }
  return { allowed: true };
}

/**
 * Pairs a call class with its own budget and usage.
 *
 * Selecting these by hand at the call site is the one way to get this wrong —
 * a normal call checked against the alert allowance, or worse, an alert checked
 * against a budget the reminders have already spent. One tested function does
 * it instead.
 */
export function selectCallBudget<T>(
  callClass: CallClass,
  perClass: { normal: T; systemAlert: T },
): T {
  return callClass === "system_alert" ? perClass.systemAlert : perClass.normal;
}

/** Fixed-window in-memory limiter. Good enough for per-process LLM call ceilings. */
export class RateLimiter {
  private windowStart = 0;
  private count = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  tryAcquire(now = Date.now()): boolean {
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count += 1;
    return true;
  }
}
