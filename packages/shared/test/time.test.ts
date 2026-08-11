import assert from "node:assert/strict";
import test from "node:test";
import { dateInZone, describeNow, isUsableTimeZone, wallTimeToUtc, zoneOffsetMs } from "../src/time.js";

const BERLIN = "Europe/Berlin";

test("a wall-clock time converts using the zone's offset on that date", () => {
  // CEST is UTC+2 in August, CET is UTC+1 in January.
  assert.equal(wallTimeToUtc([2026, 8, 11, 7, 45, 0], BERLIN).toISOString(), "2026-08-11T05:45:00.000Z");
  assert.equal(wallTimeToUtc([2026, 1, 15, 7, 45, 0], BERLIN).toISOString(), "2026-01-15T06:45:00.000Z");
});

test("times either side of a DST transition land on the correct offset", () => {
  // 2026-03-29: 02:00 CET becomes 03:00 CEST.
  assert.equal(wallTimeToUtc([2026, 3, 29, 1, 30, 0], BERLIN).toISOString(), "2026-03-29T00:30:00.000Z");
  assert.equal(wallTimeToUtc([2026, 3, 29, 4, 30, 0], BERLIN).toISOString(), "2026-03-29T02:30:00.000Z");
  // 2026-10-25: 03:00 CEST becomes 02:00 CET.
  assert.equal(wallTimeToUtc([2026, 10, 25, 1, 30, 0], BERLIN).toISOString(), "2026-10-24T23:30:00.000Z");
  assert.equal(wallTimeToUtc([2026, 10, 25, 4, 30, 0], BERLIN).toISOString(), "2026-10-25T03:30:00.000Z");
});

test("an unusable zone name falls back rather than throwing", () => {
  assert.equal(isUsableTimeZone("W. Europe Standard Time"), false);
  assert.equal(isUsableTimeZone(""), false);
  assert.equal(isUsableTimeZone(BERLIN), true);
  assert.equal(
    wallTimeToUtc([2026, 8, 11, 7, 45, 0], "Nonsense/Zone", BERLIN).toISOString(),
    "2026-08-11T05:45:00.000Z",
  );
});

test("zoneOffsetMs reports the offset in force at that instant", () => {
  assert.equal(zoneOffsetMs(Date.parse("2026-08-11T12:00:00Z"), BERLIN), 2 * 3_600_000);
  assert.equal(zoneOffsetMs(Date.parse("2026-01-15T12:00:00Z"), BERLIN), 1 * 3_600_000);
  assert.equal(zoneOffsetMs(Date.parse("2026-08-11T12:00:00Z"), "UTC"), 0);
});

test("dateInZone reads the local calendar day, not the UTC one", () => {
  // 23:30 UTC is already the next day in Berlin.
  assert.deepEqual(dateInZone(new Date("2026-08-10T23:30:00Z"), BERLIN), [2026, 8, 11]);
  assert.deepEqual(dateInZone(new Date("2026-08-10T23:30:00Z"), "UTC"), [2026, 8, 10]);
});

test("describeNow spells out the local time a model has to reason from", () => {
  const rendered = describeNow(new Date("2026-08-10T23:09:18Z"), BERLIN);
  // The instant that produced the 07:45 slip: 23:09 UTC is 01:09 on the 11th.
  assert.equal(rendered, "Tuesday 2026-08-11 01:09:18 Europe/Berlin (UTC+02:00)");

  const winter = describeNow(new Date("2026-01-15T12:00:00Z"), BERLIN);
  assert.equal(winter, "Thursday 2026-01-15 13:00:00 Europe/Berlin (UTC+01:00)");
});

test("describeNow handles midnight and negative offsets", () => {
  assert.match(describeNow(new Date("2026-08-10T22:00:00Z"), BERLIN), /2026-08-11 00:00:00/);
  assert.match(describeNow(new Date("2026-08-11T12:00:00Z"), "America/New_York"), /UTC-04:00/);
});
