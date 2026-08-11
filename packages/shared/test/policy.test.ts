import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateCallPolicy, isWithinQuietHours, selectCallBudget } from "../src/policy.js";

const quiet = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };
const budget = { maxPerHour: 2, maxPerDay: 8 };
const noUsage = { lastHour: 0, lastDay: 0 };

// 2026-08-08 is CEST, so local time is UTC+2.
describe("isWithinQuietHours", () => {
  it("handles the window that wraps midnight", () => {
    assert.equal(isWithinQuietHours(new Date("2026-08-08T23:30:00Z"), quiet), true); // 01:30
    assert.equal(isWithinQuietHours(new Date("2026-08-08T21:00:00Z"), quiet), true); // 23:00
    assert.equal(isWithinQuietHours(new Date("2026-08-08T04:30:00Z"), quiet), true); // 06:30
  });

  it("is inactive during the day", () => {
    assert.equal(isWithinQuietHours(new Date("2026-08-08T12:00:00Z"), quiet), false); // 14:00
    assert.equal(isWithinQuietHours(new Date("2026-08-08T05:30:00Z"), quiet), false); // 07:30
  });

  it("treats an empty window as never quiet", () => {
    assert.equal(
      isWithinQuietHours(new Date("2026-08-08T23:30:00Z"), { ...quiet, start: "22:00", end: "22:00" }),
      false,
    );
  });
});

describe("evaluateCallPolicy", () => {
  it("allows an ordinary daytime call", () => {
    const now = new Date("2026-08-08T12:00:00Z");
    assert.equal(
      evaluateCallPolicy({ now, urgent: false, quiet, budget, usage: noUsage }).allowed,
      true,
    );
  });

  it("blocks non-urgent calls during quiet hours", () => {
    const now = new Date("2026-08-08T23:30:00Z");
    const decision = evaluateCallPolicy({ now, urgent: false, quiet, budget, usage: noUsage });
    assert.equal(decision.allowed, false);
    assert.match(decision.allowed === false ? decision.reason : "", /quiet hours/);
  });

  it("lets an urgent call through quiet hours", () => {
    const now = new Date("2026-08-08T23:30:00Z");
    assert.equal(
      evaluateCallPolicy({ now, urgent: true, quiet, budget, usage: noUsage }).allowed,
      true,
    );
  });

  it("enforces the budget even for urgent calls", () => {
    // This is the property that stops a false-positive storm from dialling you
    // forty times: urgency overrides quiet hours, never the budget.
    const now = new Date("2026-08-08T23:30:00Z");
    const decision = evaluateCallPolicy({
      now,
      urgent: true,
      quiet,
      budget,
      usage: { lastHour: 2, lastDay: 2 },
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.allowed === false ? decision.reason : "", /hourly call budget/);
  });

  it("enforces the daily budget", () => {
    const now = new Date("2026-08-08T12:00:00Z");
    const decision = evaluateCallPolicy({
      now,
      urgent: false,
      quiet,
      budget,
      usage: { lastHour: 0, lastDay: 8 },
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.allowed === false ? decision.reason : "", /daily call budget/);
  });
});

describe("system alerts", () => {
  // The case these exist for: Jarvis promised a third party an appointment and
  // then failed to record it. The commitment lives in someone else's book, so
  // staying quiet until morning means missing it.
  const alertBudget = { maxPerHour: 1, maxPerDay: 3 };
  const night = new Date("2026-08-08T23:30:00Z"); // 01:30 Berlin

  it("passes quiet hours without being marked urgent", () => {
    const decision = evaluateCallPolicy({
      now: night,
      urgent: false,
      quiet,
      budget: alertBudget,
      usage: noUsage,
      callClass: "system_alert",
    });
    assert.equal(decision.allowed, true);
  });

  it("is still bounded by its own budget", () => {
    // An alarm that can repeat without limit is itself a way to be dialled all
    // night. Waking you is the exception; doing it unboundedly is not.
    const decision = evaluateCallPolicy({
      now: night,
      urgent: false,
      quiet,
      budget: alertBudget,
      usage: { lastHour: 0, lastDay: 3 },
      callClass: "system_alert",
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.allowed === false ? decision.reason : "", /daily call budget/);
  });

  it("does not draw on the same allowance as ordinary calls", () => {
    // The whole point of the split: a day of reminders must not be able to
    // consume the emergency channel, which is exactly what a shared counter did.
    const spentOnReminders = { lastHour: 2, lastDay: 8 };
    assert.equal(
      evaluateCallPolicy({
        now: new Date("2026-08-08T12:00:00Z"),
        urgent: false,
        quiet,
        budget,
        usage: spentOnReminders,
      }).allowed,
      false,
      "the ordinary budget is exhausted",
    );
    assert.equal(
      evaluateCallPolicy({
        now: new Date("2026-08-08T12:00:00Z"),
        urgent: false,
        quiet,
        budget: alertBudget,
        usage: noUsage,
        callClass: "system_alert",
      }).allowed,
      true,
      "the alert allowance is untouched by them",
    );
  });

  it("selectCallBudget pairs a class with its own limits", () => {
    const perClass = { normal: budget, systemAlert: alertBudget };
    assert.deepEqual(selectCallBudget("normal", perClass), budget);
    assert.deepEqual(selectCallBudget("system_alert", perClass), alertBudget);
  });
});

describe("evaluateCallPolicy with limits disabled", () => {
  const now = new Date("2026-08-08T12:00:00Z");

  it("treats 0 as no limit rather than as a total block", () => {
    // The literal reading would make "remove the cap" silently mean "never
    // call me again", which is the opposite of the intent.
    const decision = evaluateCallPolicy({
      now,
      urgent: false,
      quiet,
      budget: { maxPerHour: 0, maxPerDay: 0 },
      usage: { lastHour: 99, lastDay: 999 },
    });
    assert.equal(decision.allowed, true);
  });

  it("still applies a daily cap when only the hourly one is disabled", () => {
    const decision = evaluateCallPolicy({
      now,
      urgent: false,
      quiet,
      budget: { maxPerHour: 0, maxPerDay: 8 },
      usage: { lastHour: 50, lastDay: 8 },
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.allowed === false ? decision.reason : "", /daily/);
  });

  it("still honours quiet hours when budgets are disabled", () => {
    // Removing the cap must not accidentally remove the 3am protection too.
    const decision = evaluateCallPolicy({
      now: new Date("2026-08-08T23:30:00Z"),
      urgent: false,
      quiet,
      budget: { maxPerHour: 0, maxPerDay: 0 },
      usage: noUsage,
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.allowed === false ? decision.reason : "", /quiet hours/);
  });
});
