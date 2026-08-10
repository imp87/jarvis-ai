import assert from "node:assert/strict";
import test from "node:test";
import { isExplicitCalendarRequest } from "../src/agent/tools/calendar.js";
import {
  buildCalendarObject,
  escapeText,
  foldLine,
  newEventUid,
} from "../src/services/caldav/ical-write.js";
import { parseVEvents } from "../src/services/caldav/ical.js";

// --- Consent ---------------------------------------------------------------

test("create is allowed for the separable phrasings people actually use", () => {
  for (const phrase of [
    "Trag mir am Montag um zehn den Zahnarzt ein.",
    "Trag das bitte ein",
    "Leg einen Termin für Dienstag an.",
    "Erstell mir bitte einen Termin.",
    "Mach mir einen Termin am Freitag.",
    "Notier das für morgen.",
    "Blockier mir den Nachmittag.",
  ]) {
    assert.equal(isExplicitCalendarRequest(phrase, "create"), true, phrase);
  }
});

test("update and delete accept their own natural phrasings", () => {
  for (const phrase of [
    "Verschieb den Zahnarzt auf 14 Uhr.",
    "Leg den Termin bitte um.",
    "Ändere den Titel auf Steuerberater.",
    "Schieb das auf Donnerstag.",
  ]) {
    assert.equal(isExplicitCalendarRequest(phrase, "update"), true, phrase);
  }
  for (const phrase of [
    "Lösch den Termin am Achtzehnten.",
    "Sag den Zahnarzt bitte ab.",
    "Nimm das aus dem Kalender raus.",
    "Streich den Termin.",
  ]) {
    assert.equal(isExplicitCalendarRequest(phrase, "delete"), true, phrase);
  }
});

test("an utterance that asks for nothing cannot reach a write", () => {
  // The threat this exists for: a tool result or mail body steering a write
  // while the user only asked to be read to.
  for (const phrase of [
    "Was steht am 18. August an?",
    "Lies mir meine Mails vor.",
    "Danke, passt.",
    "",
  ]) {
    for (const action of ["create", "update", "delete"] as const) {
      assert.equal(isExplicitCalendarRequest(phrase, action), false, `${action}: ${phrase}`);
    }
  }
});

test("the verb sets do not bleed into each other", () => {
  assert.equal(isExplicitCalendarRequest("Lösch den Termin.", "create"), false);
  assert.equal(isExplicitCalendarRequest("Trag den Termin ein.", "delete"), false);
});

test("a refusal ahead of the verb is not consent", () => {
  assert.equal(isExplicitCalendarRequest("Nicht löschen bitte.", "delete"), false);
  assert.equal(isExplicitCalendarRequest("Kein Termin anlegen.", "create"), false);
  assert.equal(isExplicitCalendarRequest("Warte, noch nicht verschieben.", "update"), false);
});

// --- Writing iCalendar -----------------------------------------------------

test("a generated timed event round-trips back through the parser", () => {
  const ics = buildCalendarObject({
    uid: "uid-1@jarvis",
    summary: "Zahnarzt",
    location: "Hauptstr. 1",
    description: "Karte mitnehmen",
    start: new Date("2026-08-18T07:00:00Z"),
    end: new Date("2026-08-18T08:00:00Z"),
    allDay: false,
  });

  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"), "must use CRLF line endings");
  assert.match(ics, /DTSTART:20260818T070000Z/);
  assert.match(ics, /DTEND:20260818T080000Z/);

  const [event] = parseVEvents(ics, "Europe/Berlin");
  assert.equal(event?.summary, "Zahnarzt");
  assert.equal(event?.location, "Hauptstr. 1");
  assert.equal(event?.description, "Karte mitnehmen");
  assert.equal(event?.start.toISOString(), "2026-08-18T07:00:00.000Z");
  assert.equal(event?.allDay, false);
});

test("a generated all-day event uses DATE values and an exclusive end", () => {
  const ics = buildCalendarObject({
    uid: "uid-2@jarvis",
    summary: "Urlaub",
    start: new Date(Date.UTC(2026, 7, 18)),
    end: new Date(Date.UTC(2026, 7, 21)),
    allDay: true,
  });
  assert.match(ics, /DTSTART;VALUE=DATE:20260818/);
  assert.match(ics, /DTEND;VALUE=DATE:20260821/);

  const [event] = parseVEvents(ics, "Europe/Berlin");
  assert.equal(event?.allDay, true);
  assert.equal(event?.start.toISOString(), "2026-08-18T00:00:00.000Z");
  assert.equal(event?.end.toISOString(), "2026-08-21T00:00:00.000Z");
});

test("special characters survive the escape and parse round trip", () => {
  const summary = "Meeting; Müller, Schmidt \\ Co\nzweite Zeile";
  const ics = buildCalendarObject({
    uid: "uid-3@jarvis",
    summary,
    start: new Date("2026-08-18T07:00:00Z"),
    end: new Date("2026-08-18T08:00:00Z"),
    allDay: false,
  });
  const [event] = parseVEvents(ics, "Europe/Berlin");
  assert.equal(event?.summary, summary);
  assert.equal(escapeText("a,b;c\\d"), "a\\,b\\;c\\\\d");
});

test("long lines fold at 75 octets without splitting a multi-byte character", () => {
  const line = `SUMMARY:${"ü".repeat(120)}`;
  const folded = foldLine(line);
  assert.ok(folded.length > 1, "a 240-octet line must fold");
  for (const part of folded) {
    assert.ok(Buffer.byteLength(part, "utf8") <= 75, `part too long: ${Buffer.byteLength(part, "utf8")}`);
  }
  // Rejoining the physical lines must give back exactly the original.
  const rejoined = folded.map((part, index) => (index === 0 ? part : part.slice(1))).join("");
  assert.equal(rejoined, line);
  assert.ok(!rejoined.includes("�"), "no character may be cut in half");
});

test("an umlaut title survives folding all the way back through the parser", () => {
  const summary = `Besprechung über ${"Änderungswünsche ".repeat(6)}`.trim();
  const ics = buildCalendarObject({
    uid: "uid-4@jarvis",
    summary,
    start: new Date("2026-08-18T07:00:00Z"),
    end: new Date("2026-08-18T08:00:00Z"),
    allDay: false,
  });
  const [event] = parseVEvents(ics, "Europe/Berlin");
  assert.equal(event?.summary, summary);
});

test("an update writes a higher SEQUENCE than the event it replaces", () => {
  const ics = buildCalendarObject({
    uid: "uid-5@jarvis",
    summary: "Verschoben",
    start: new Date("2026-08-18T07:00:00Z"),
    end: new Date("2026-08-18T08:00:00Z"),
    allDay: false,
    sequence: 3,
  });
  assert.match(ics, /SEQUENCE:3/);
  assert.equal(parseVEvents(ics, "UTC")[0]?.sequence, 3);
});

test("generated UIDs are unique and namespaced", () => {
  const first = newEventUid();
  assert.notEqual(first, newEventUid());
  assert.match(first, /@jarvis$/);
});
