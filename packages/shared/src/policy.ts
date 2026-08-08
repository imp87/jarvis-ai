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
  maxPerHour: number;
  maxPerDay: number;
}

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
  budget: CallBudget;
  usage: CallBudgetUsage;
}): PolicyDecision {
  const { now, urgent, quiet, budget, usage } = input;

  // Budget applies even to urgent calls — the whole point is that a
  // false-positive storm can't dial you 40 times.
  if (usage.lastHour >= budget.maxPerHour) {
    return {
      allowed: false,
      reason: `hourly call budget exhausted (${usage.lastHour}/${budget.maxPerHour})`,
      retryAfterSeconds: 3600,
    };
  }
  if (usage.lastDay >= budget.maxPerDay) {
    return {
      allowed: false,
      reason: `daily call budget exhausted (${usage.lastDay}/${budget.maxPerDay})`,
      retryAfterSeconds: 86_400,
    };
  }
  if (!urgent && isWithinQuietHours(now, quiet)) {
    return {
      allowed: false,
      reason: `quiet hours active (${quiet.start}-${quiet.end} ${quiet.timezone})`,
    };
  }
  return { allowed: true };
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
