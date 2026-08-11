import assert from "node:assert/strict";
import test from "node:test";
import type { CallMandateRow } from "@jarvis/db";
import { MandateService, grantsBookingAuthority } from "../src/services/mandates.js";

const service = new MandateService({
  mandates: {} as never,
  caldav: {} as never,
  logger: { info() {}, warn() {}, error() {} } as never,
  timezone: "Europe/Berlin",
});

function mandate(overrides: Partial<CallMandateRow> = {}): CallMandateRow {
  return {
    id: "m1", userId: "u1", callLogId: "c1", contactId: null,
    errand: "Haareschneiden",
    candidateSlots: [
      { id: "s1", startsAt: "2026-08-12T07:00:00.000Z", endsAt: "2026-08-12T08:00:00.000Z" },
      { id: "s2", startsAt: "2026-08-12T09:00:00.000Z", endsAt: "2026-08-12T10:00:00.000Z" },
    ],
    durationMinutes: 60, expiresAt: new Date(), state: "pending",
    agreedSlotId: null, eventUid: null, resolutionNote: null, createdAt: new Date(),
    ...overrides,
  };
}

// --- Booking authority -----------------------------------------------------

test("mentioning an appointment grants the booking authority", () => {
  for (const phrase of [
    "Frag beim Bürgeramt, ob ich für die Ummeldung einen Termin brauche",
    "Ruf den Friseur an und vereinbare was",
    "Frag ob sie glutenfrei haben und reservier gleich",
    "Mach das direkt in meinen Kalender rein",
  ]) {
    assert.equal(grantsBookingAuthority(phrase), true, phrase);
  }
});

test("a pure question grants nothing", () => {
  // Without this the agent could agree to something on a call the owner only
  // meant as an enquiry.
  for (const phrase of [
    "Ruf bei der Werkstatt an, ob mein Auto fertig ist",
    "Frag im Restaurant, ob sie glutenfrei haben",
    "Ruf da mal an",
    "",
  ]) {
    assert.equal(grantsBookingAuthority(phrase), false, phrase);
  }
});

// --- The closed set --------------------------------------------------------

test("only an id from the frozen set is accepted", () => {
  assert.equal(service.matchAgreedSlot(mandate(), "s2")?.id, "s2");
  assert.equal(service.matchAgreedSlot(mandate(), " s1 ")?.id, "s1");
});

test("an id that is not in the set is refused", () => {
  // The model naming a slot that does not exist must not become an appointment.
  assert.equal(service.matchAgreedSlot(mandate(), "s9"), undefined);
});

test("a date is never accepted, however clearly it is stated", () => {
  // The whole point: the far end selects, it never supplies a value.
  for (const answer of ["2026-08-12T07:00:00Z", "Dienstag 14 Uhr", "morgen um 18 Uhr"]) {
    assert.equal(service.matchAgreedSlot(mandate(), answer), undefined, answer);
  }
});

test("a hedged answer does not pick a slot", () => {
  // "none of s1, s2" must not be read as having chosen s1.
  for (const answer of ["none", "none of s1, s2", "unclear", "s1 or s2", "vielleicht s1"]) {
    assert.equal(service.matchAgreedSlot(mandate(), answer), undefined, answer);
  }
});

// --- Briefing --------------------------------------------------------------

test("without slots the agent is told it may not agree to anything", () => {
  const briefing = service.briefingFor(mandate({ candidateSlots: null }), "Europe/Berlin");
  assert.match(briefing, /NUR fragen/);
  assert.match(briefing, /keinen Termin zusagen/);
});

test("with slots the agent gets the closed set and the rule around it", () => {
  const briefing = service.briefingFor(mandate(), "Europe/Berlin");
  assert.match(briefing, /AUSSCHLIESSLICH/);
  assert.match(briefing, /s1: Mittwoch, 12\.08\. um 09:00 Uhr/);
  assert.match(briefing, /Erfinde niemals eine andere Uhrzeit/);
});

test("a null mandate is treated exactly like no authority", () => {
  // A call with no mandate row at all must not silently become permissive.
  assert.match(service.briefingFor(null, "Europe/Berlin"), /NUR fragen/);
});
