import assert from "node:assert/strict";
import test from "node:test";
import {
  isUsableTimeZone,
  parseIcalDuration,
  parseVEvents,
  unescapeText,
  unfold,
  wallTimeToUtc,
} from "../src/services/caldav/ical.js";

const BERLIN = "Europe/Berlin";

function ics(...lines: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
}

test("folded lines are rejoined before parsing", () => {
  assert.deepEqual(unfold("SUMMARY:Ein sehr\r\n  langer Titel\r\nUID:1"), [
    "SUMMARY:Ein sehr langer Titel",
    "UID:1",
  ]);
});

test("a UTC timed event is read as the instant it states", () => {
  const [event] = parseVEvents(
    ics(
      "BEGIN:VEVENT",
      "UID:a@example.com",
      "SUMMARY:Zahnarzt",
      "LOCATION:Hauptstr. 1",
      "DTSTART:20260810T090000Z",
      "DTEND:20260810T100000Z",
      "END:VEVENT",
    ),
    BERLIN,
  );
  assert.equal(event?.summary, "Zahnarzt");
  assert.equal(event?.location, "Hauptstr. 1");
  assert.equal(event?.start.toISOString(), "2026-08-10T09:00:00.000Z");
  assert.equal(event?.end.toISOString(), "2026-08-10T10:00:00.000Z");
  assert.equal(event?.allDay, false);
});

test("a TZID wall time is converted using the zone, on both sides of DST", () => {
  const summer = parseVEvents(
    ics("BEGIN:VEVENT", "UID:s", "SUMMARY:Sommer", "DTSTART;TZID=Europe/Berlin:20260701T120000", "END:VEVENT"),
    "UTC",
  );
  // CEST is UTC+2.
  assert.equal(summer[0]?.start.toISOString(), "2026-07-01T10:00:00.000Z");

  const winter = parseVEvents(
    ics("BEGIN:VEVENT", "UID:w", "SUMMARY:Winter", "DTSTART;TZID=Europe/Berlin:20260115T120000", "END:VEVENT"),
    "UTC",
  );
  // CET is UTC+1.
  assert.equal(winter[0]?.start.toISOString(), "2026-01-15T11:00:00.000Z");
});

test("wallTimeToUtc lands on the right side of a spring-forward transition", () => {
  // 2026-03-29 is the European switch: 02:00 CET becomes 03:00 CEST.
  assert.equal(wallTimeToUtc([2026, 3, 29, 1, 30, 0], BERLIN, "UTC").toISOString(), "2026-03-29T00:30:00.000Z");
  assert.equal(wallTimeToUtc([2026, 3, 29, 4, 30, 0], BERLIN, "UTC").toISOString(), "2026-03-29T02:30:00.000Z");
});

test("a floating time without TZID uses the owner's zone", () => {
  const [event] = parseVEvents(
    ics("BEGIN:VEVENT", "UID:f", "SUMMARY:Floating", "DTSTART:20260701T120000", "END:VEVENT"),
    BERLIN,
  );
  assert.equal(event?.start.toISOString(), "2026-07-01T10:00:00.000Z");
});

test("a Windows zone name falls back instead of dropping the event", () => {
  assert.equal(isUsableTimeZone("W. Europe Standard Time"), false);
  assert.equal(isUsableTimeZone("Europe/Berlin"), true);
  const [event] = parseVEvents(
    ics(
      "BEGIN:VEVENT",
      "UID:x",
      "SUMMARY:Exchange",
      'DTSTART;TZID="W. Europe Standard Time":20260701T120000',
      "END:VEVENT",
    ),
    BERLIN,
  );
  assert.equal(event?.start.toISOString(), "2026-07-01T10:00:00.000Z");
});

test("an all-day event covers exactly one day and is flagged", () => {
  const [event] = parseVEvents(
    ics("BEGIN:VEVENT", "UID:d", "SUMMARY:Urlaub", "DTSTART;VALUE=DATE:20260810", "END:VEVENT"),
    BERLIN,
  );
  assert.equal(event?.allDay, true);
  assert.equal(event?.start.toISOString(), "2026-08-10T00:00:00.000Z");
  assert.equal(event?.end.toISOString(), "2026-08-11T00:00:00.000Z");
});

test("DURATION substitutes for a missing DTEND", () => {
  const [event] = parseVEvents(
    ics(
      "BEGIN:VEVENT",
      "UID:p",
      "SUMMARY:Call",
      "DTSTART:20260810T090000Z",
      "DURATION:PT1H30M",
      "END:VEVENT",
    ),
    BERLIN,
  );
  assert.equal(event?.end.toISOString(), "2026-08-10T10:30:00.000Z");
  assert.equal(parseIcalDuration("P1W"), 604_800_000);
  assert.equal(parseIcalDuration("-PT15M"), -900_000);
  assert.equal(parseIcalDuration("nonsense"), undefined);
});

test("escaped text is unescaped and a VALARM cannot overwrite the event", () => {
  const [event] = parseVEvents(
    ics(
      "BEGIN:VEVENT",
      "UID:v",
      "SUMMARY:Meeting mit Schmidt\\, Müller & Co.",
      "DESCRIPTION:Zeile eins\\nZeile zwei",
      "DTSTART:20260810T090000Z",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:Erinnerung",
      "TRIGGER:-PT15M",
      "END:VALARM",
      "END:VEVENT",
    ),
    BERLIN,
  );
  assert.equal(event?.summary, "Meeting mit Schmidt, Müller & Co.");
  assert.equal(event?.description, "Zeile eins\nZeile zwei");
  assert.equal(unescapeText("a\\;b\\\\c"), "a;b\\c");
});

test("an unexpanded master is reported as recurring", () => {
  const [event] = parseVEvents(
    ics(
      "BEGIN:VEVENT",
      "UID:r",
      "SUMMARY:Jour fixe",
      "DTSTART:20260810T090000Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "END:VEVENT",
    ),
    BERLIN,
  );
  assert.equal(event?.recurring, true);
});

test("an event without DTSTART is skipped rather than guessed at", () => {
  const events = parseVEvents(
    ics("BEGIN:VEVENT", "UID:broken", "SUMMARY:Kaputt", "END:VEVENT"),
    BERLIN,
  );
  assert.deepEqual(events, []);
});
