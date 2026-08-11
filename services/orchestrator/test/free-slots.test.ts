import assert from "node:assert/strict";
import test from "node:test";
import { computeFreeSlots, describeSlots } from "../src/services/free-slots.js";

const TZ = "Europe/Berlin";
// Tuesday 2026-08-11, 08:00 Berlin.
const FROM = new Date("2026-08-11T06:00:00Z");
const TO = new Date("2026-08-13T22:00:00Z");

const base = { from: FROM, to: TO, durationMinutes: 60, timezone: TZ };

test("free time becomes aligned, sayable slots", () => {
  const slots = computeFreeSlots([], { ...base, limit: 3 });
  assert.equal(slots.length, 3);
  // 09:00 Berlin on the first day, which is 07:00 UTC in CEST.
  assert.equal(slots[0]?.startsAt, "2026-08-11T07:00:00.000Z");
  // Second slot of a day is the afternoon, not the next half hour.
  assert.equal(slots[1]?.startsAt, "2026-08-11T11:00:00.000Z");
  // Ids are short and stable so they can be said and matched back.
  assert.deepEqual(slots.map((s) => s.id), ["s1", "s2", "s3"]);
});

test("a busy period blocks every slot it touches", () => {
  const busy = [{ start: new Date("2026-08-11T07:00:00Z"), end: new Date("2026-08-11T09:00:00Z") }];
  const slots = computeFreeSlots(busy, { ...base, limit: 2 });
  // 09:00–11:00 Berlin is taken, so the first free hour starts at 11:00.
  assert.equal(slots[0]?.startsAt, "2026-08-11T09:00:00.000Z");
});

test("overlapping busy periods do not leave a phantom gap between them", () => {
  // 10:00–11:00 and 10:30–12:00 are busy until 12:00, not free at 11:00.
  const busy = [
    { start: new Date("2026-08-11T08:00:00Z"), end: new Date("2026-08-11T09:00:00Z") },
    { start: new Date("2026-08-11T08:30:00Z"), end: new Date("2026-08-11T10:00:00Z") },
  ];
  const slots = computeFreeSlots(busy, { ...base, limit: 5 });
  assert.ok(
    !slots.some((s) => s.startsAt === "2026-08-11T09:00:00.000Z"),
    "11:00 Berlin must still be busy",
  );
});

test("an event ending exactly when a slot starts does not block it", () => {
  const busy = [{ start: new Date("2026-08-11T06:00:00Z"), end: new Date("2026-08-11T07:00:00Z") }];
  const slots = computeFreeSlots(busy, { ...base, limit: 1 });
  assert.equal(slots[0]?.startsAt, "2026-08-11T07:00:00.000Z");
});

test("slots stay inside the working window", () => {
  const slots = computeFreeSlots([], { ...base, limit: 50, earliestHour: 9, latestHour: 18 });
  for (const slot of slots) {
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false })
        .format(new Date(slot.startsAt)),
    );
    assert.ok(hour >= 9 && hour <= 17, `slot at ${hour} is outside 9–18`);
  }
});

test("Sunday is not offered by default", () => {
  // 2026-08-16 is a Sunday.
  const slots = computeFreeSlots([], {
    ...base,
    from: new Date("2026-08-16T04:00:00Z"),
    to: new Date("2026-08-16T20:00:00Z"),
    limit: 5,
  });
  assert.deepEqual(slots, []);
});

test("nothing before `from` is ever offered", () => {
  // Asked at 14:00 Berlin: the morning of the same day is already gone.
  const slots = computeFreeSlots([], { ...base, from: new Date("2026-08-11T12:00:00Z"), limit: 1 });
  assert.ok(new Date(slots[0]!.startsAt).getTime() >= new Date("2026-08-11T12:00:00Z").getTime());
});

test("the spoken form names the day and the time", () => {
  const slots = computeFreeSlots([], { ...base, limit: 1 });
  const text = describeSlots(slots, TZ);
  assert.match(text, /^s1: Dienstag, 11\.08\. um 09:00 Uhr$/);
});

test("slots are spread across days rather than clustered in one morning", () => {
  // Six half-hourly slots on one morning is not a choice anyone can answer on
  // the phone: "hätten Sie 9:00, 9:30, 10:00, 10:30, 11:00 oder 11:30?"
  const slots = computeFreeSlots([], { ...base, to: new Date("2026-08-20T22:00:00Z"), limit: 6 });
  const days = new Set(
    slots.map((s) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: TZ, dateStyle: "short" })
        .format(new Date(s.startsAt)),
    ),
  );
  assert.ok(days.size >= 3, `expected at least 3 distinct days, got ${days.size}`);
  assert.ok(slots.length <= 6);
});

test("a day offers a morning and an afternoon, never two adjacent hours", () => {
  const slots = computeFreeSlots([], { ...base, limit: 2 });
  const gap = new Date(slots[1]!.startsAt).getTime() - new Date(slots[0]!.startsAt).getTime();
  assert.ok(gap >= 3 * 3_600_000, `slots only ${gap / 3_600_000}h apart`);
});
