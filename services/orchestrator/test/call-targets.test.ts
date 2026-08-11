import assert from "node:assert/strict";
import test from "node:test";
import type { ContactRepository, ContactRow } from "@jarvis/db";
import { numbersMentionedIn, resolveCallTarget } from "../src/services/call-targets.js";

const OWNER = "+4917612345678";
const SALON = "+4915561049738";

function contact(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: "c1",
    userId: "u1",
    name: "Friseur",
    phoneE164: SALON,
    note: null,
    allowCalls: true,
    createdBy: "user",
    createdAt: new Date(),
    ...overrides,
  };
}

/** Only `findByName` is reachable from the resolver. */
function repo(rows: ContactRow[]): ContactRepository {
  return {
    async findByName(_userId: string, needle: string) {
      const term = needle.trim().toLowerCase();
      const all = rows.filter((row) => row.name.toLowerCase().includes(term));
      const exact = all.filter((row) => row.name.toLowerCase() === term);
      return exact.length > 0 ? exact : all;
    },
  } as unknown as ContactRepository;
}

const enabled = { ownerPhoneNumber: OWNER, outboundCallsEnabled: true };

test("no selector still calls the owner, as it always did", async () => {
  const result = await resolveCallTarget("u1", undefined, "erinnere mich", {
    contacts: repo([]),
    ...enabled,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.target, { kind: "owner", phoneE164: OWNER });
});

test("an approved contact resolves by name", async () => {
  const result = await resolveCallTarget("u1", "Friseur", "ruf den friseur an", {
    contacts: repo([contact()]),
    ...enabled,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.target.phoneE164, SALON);
});

test("a contact without allow_calls is refused", async () => {
  // The whole point of the flag: knowing a number is not permission to dial it.
  const result = await resolveCallTarget("u1", "Friseur", "ruf den friseur an", {
    contacts: repo([contact({ allowCalls: false })]),
    ...enabled,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /nicht für Anrufe freigegeben/);
});

test("an ambiguous name is reported, never guessed at", async () => {
  // Dialling the wrong one of two saved businesses cannot be undone by hanging up.
  const result = await resolveCallTarget("u1", "Salon", "ruf im salon an", {
    contacts: repo([
      contact({ id: "a", name: "Salon Meier" }),
      contact({ id: "b", name: "Salon Schmidt", phoneE164: "+4915511111111" }),
    ]),
    ...enabled,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /Mehrere Kontakte/);
});

test("an exact name wins over a longer one that merely contains it", async () => {
  const result = await resolveCallTarget("u1", "Friseur", "ruf den friseur an", {
    contacts: repo([
      contact({ id: "a", name: "Friseur" }),
      contact({ id: "b", name: "Friseur Zweitsalon", phoneE164: "+4915522222222" }),
    ]),
    ...enabled,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.target.phoneE164, SALON);
});

// --- The security boundary -------------------------------------------------

test("a number the user dictated in THIS message may be dialled", async () => {
  const result = await resolveCallTarget(
    "u1",
    "+4915561049738",
    "Ruf mal die 0155 6104 9738 an und frag ob offen ist",
    { contacts: repo([]), ...enabled },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.target, { kind: "dictated", phoneE164: SALON });
});

test("a number that is NOT in the user's message is refused", async () => {
  // This is the attack: a number lifted from a mail body or a web page that the
  // read tools fed to the model two turns ago. On the model's own terms it is
  // indistinguishable from one the owner typed, so the check is made against
  // the owner's actual words instead.
  const result = await resolveCallTarget("u1", "+4930999999", "ruf da mal an", {
    contacts: repo([]),
    ...enabled,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /steht nicht in der aktuellen Nachricht/);
});

test("the global switch blocks every third party, but not the owner", async () => {
  const off = { contacts: repo([contact()]), ownerPhoneNumber: OWNER, outboundCallsEnabled: false };

  const toContact = await resolveCallTarget("u1", "Friseur", "ruf den friseur an", off);
  assert.equal(toContact.ok, false);
  assert.match(toContact.ok === false ? toContact.reason : "", /abgeschaltet/);

  // Ringing your own phone commits nothing to anyone else, so the reminder
  // behaviour keeps working while outbound calling is still switched off.
  const toOwner = await resolveCallTarget("u1", undefined, "erinnere mich", off);
  assert.equal(toOwner.ok, true);
});

test("an unknown name is not silently treated as a number", async () => {
  const result = await resolveCallTarget("u1", "Zahnarzt", "ruf den zahnarzt an", {
    contacts: repo([contact()]),
    ...enabled,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /keinen Kontakt/);
});

// --- Extraction ------------------------------------------------------------

test("numbers are found however a person types them", async () => {
  assert.deepEqual(numbersMentionedIn("meine Nummer ist 0155 6104 9738"), [SALON]);
  assert.deepEqual(numbersMentionedIn("0155-61049738 ist die"), [SALON]);
  assert.deepEqual(numbersMentionedIn("+49 155 61049738"), [SALON]);
  assert.deepEqual(numbersMentionedIn("0049 155 61049738"), [SALON]);
});

test("things that merely look numeric are not phone numbers", async () => {
  // A date or a price must not become a dialable target.
  assert.deepEqual(numbersMentionedIn("am 18.08.2026 um 14:00"), []);
  assert.deepEqual(numbersMentionedIn("das kostet 39,90"), []);
  assert.deepEqual(numbersMentionedIn("Bestellung 2026-08-11 um 14:00"), []);
  assert.deepEqual(numbersMentionedIn("kein Anruf nötig"), []);
});
