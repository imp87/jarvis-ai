import { CronExpressionParser } from "cron-parser";
import type { ScheduleKind } from "@jarvis/db";

/**
 * When a task should next run.
 *
 * Two forms, because they fail in opposite ways. An interval is impossible to
 * get wrong and impossible to express "every weekday at 08:00" with; cron says
 * that in five characters and is exactly the syntax a model most often gets
 * subtly wrong — and a wrong cron either never fires or fires far too often.
 * Offering both lets the simple case stay simple and keeps the sharp tool
 * available where it earns its keep.
 */

export interface Schedule {
  kind: ScheduleKind;
  intervalSeconds?: number | null;
  cron?: string | null;
  timezone: string;
}

/**
 * Never faster than this. A task on a 10-second loop is a busy wait with an
 * API bill attached, and by the time anyone notices it has run 8 000 times.
 */
export const MIN_INTERVAL_SECONDS = 60;

export class ScheduleError extends Error {}

/**
 * @returns the next occurrence strictly after `from`, or null for a one-off
 * that has now been consumed.
 */
export function nextRunAt(schedule: Schedule, from: Date = new Date()): Date | null {
  switch (schedule.kind) {
    case "once":
      // A one-off is scheduled at creation and never rescheduled; reaching here
      // means it has just run.
      return null;

    case "interval": {
      const seconds = schedule.intervalSeconds ?? 0;
      if (seconds < MIN_INTERVAL_SECONDS) {
        throw new ScheduleError(`interval must be at least ${MIN_INTERVAL_SECONDS} seconds`);
      }
      return new Date(from.getTime() + seconds * 1000);
    }

    case "cron": {
      if (!schedule.cron) throw new ScheduleError("a cron expression is required");
      try {
        return CronExpressionParser.parse(schedule.cron, {
          currentDate: from,
          tz: schedule.timezone,
        })
          .next()
          .toDate();
      } catch (err) {
        throw new ScheduleError(
          `"${schedule.cron}" is not a valid cron expression: ${(err as Error).message}`,
        );
      }
    }

    default:
      throw new ScheduleError(`unknown schedule kind: ${String(schedule.kind)}`);
  }
}

/**
 * Rejects a schedule before it is stored.
 *
 * Validation happens at write time on purpose: a cron that only fails when it
 * is first evaluated would leave a task sitting at `next_run_at NULL`, looking
 * enabled and never running — the worst kind of broken, because nothing
 * reports it.
 */
export function validateSchedule(schedule: Schedule): void {
  if (schedule.kind === "once") return;
  nextRunAt(schedule, new Date());
}

/** Human-readable, for the UI and for telling the agent what it just created. */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case "once":
      return "once";
    case "interval": {
      const seconds = schedule.intervalSeconds ?? 0;
      if (seconds % 3600 === 0) return `every ${seconds / 3600} hour(s)`;
      if (seconds % 60 === 0) return `every ${seconds / 60} minute(s)`;
      return `every ${seconds} seconds`;
    }
    case "cron":
      return `cron "${schedule.cron}" (${schedule.timezone})`;
    default:
      return "unknown";
  }
}
