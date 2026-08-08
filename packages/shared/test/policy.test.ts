import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateCallPolicy, isWithinQuietHours } from "../src/policy.js";

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
