import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MIN_INTERVAL_SECONDS,
  ScheduleError,
  describeSchedule,
  nextRunAt,
  validateSchedule,
} from "../src/services/schedule.js";

const TZ = "Europe/Berlin";

describe("nextRunAt — intervals", () => {
  it("adds the interval to the current time", () => {
    const from = new Date("2026-08-09T10:00:00Z");
    const next = nextRunAt({ kind: "interval", intervalSeconds: 300, timezone: TZ }, from);
    assert.equal(next?.toISOString(), "2026-08-09T10:05:00.000Z");
  });

  it("refuses anything faster than the floor", () => {
    // A ten-second task is a busy loop with an API bill attached, and by the
    // time anyone notices it has run thousands of times.
    assert.throws(
      () => nextRunAt({ kind: "interval", intervalSeconds: 10, timezone: TZ }, new Date()),
      ScheduleError,
    );
    assert.doesNotThrow(() =>
      nextRunAt({ kind: "interval", intervalSeconds: MIN_INTERVAL_SECONDS, timezone: TZ }, new Date()),
    );
  });
});

describe("nextRunAt — cron", () => {
  it("finds the next weekday morning", () => {
    // Sunday; the next 08:00 weekday slot is Monday.
    const from = new Date("2026-08-09T12:00:00Z");
    const next = nextRunAt({ kind: "cron", cron: "0 8 * * 1-5", timezone: TZ }, from);
    assert.equal(next?.toISOString(), "2026-08-10T06:00:00.000Z"); // 08:00 CEST
  });

  it("interprets the expression in the task's timezone, not the server's", () => {
    // The same expression in UTC would fire two hours later in August; getting
    // this wrong means "08:00" silently drifts with wherever the box happens to be.
    const from = new Date("2026-08-09T12:00:00Z");
    const berlin = nextRunAt({ kind: "cron", cron: "0 8 * * 1-5", timezone: TZ }, from);
    const utc = nextRunAt({ kind: "cron", cron: "0 8 * * 1-5", timezone: "UTC" }, from);
    assert.notEqual(berlin?.toISOString(), utc?.toISOString());
    assert.equal(utc?.toISOString(), "2026-08-10T08:00:00.000Z");
  });

  it("rejects a malformed expression instead of storing it", () => {
    // Stored unchecked, this would sit at next_run_at NULL looking enabled and
    // never run — the worst failure mode, because nothing reports it.
    assert.throws(
      () => nextRunAt({ kind: "cron", cron: "not a cron", timezone: TZ }, new Date()),
      ScheduleError,
    );
  });

  it("always moves forward, never returns the current instant", () => {
    const from = new Date("2026-08-10T06:00:00.000Z"); // exactly a firing time
    const next = nextRunAt({ kind: "cron", cron: "0 8 * * 1-5", timezone: TZ }, from);
    assert.ok(next && next.getTime() > from.getTime(), "a schedule that returns now would spin");
  });
});

describe("nextRunAt — one-off", () => {
  it("has no next run once it has fired", () => {
    assert.equal(nextRunAt({ kind: "once", timezone: TZ }, new Date()), null);
  });
});

describe("validateSchedule", () => {
  it("accepts what the runner can evaluate", () => {
    assert.doesNotThrow(() =>
      validateSchedule({ kind: "interval", intervalSeconds: 300, timezone: TZ }),
    );
    assert.doesNotThrow(() => validateSchedule({ kind: "cron", cron: "*/15 * * * *", timezone: TZ }));
  });

  it("rejects a cron schedule with no expression", () => {
    assert.throws(() => validateSchedule({ kind: "cron", cron: null, timezone: TZ }), ScheduleError);
  });
});

describe("describeSchedule", () => {
  it("prefers the largest whole unit", () => {
    assert.equal(describeSchedule({ kind: "interval", intervalSeconds: 300, timezone: TZ }), "every 5 minute(s)");
    assert.equal(describeSchedule({ kind: "interval", intervalSeconds: 7200, timezone: TZ }), "every 2 hour(s)");
  });
});
