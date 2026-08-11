import assert from "node:assert/strict";
import test from "node:test";
import {
  GAP,
  STEM_REST,
  isExplicitRequest,
  normalizeUtterance,
  particle,
  verb,
} from "../src/agent/consent.js";

test("normalisation strips punctuation so a trailing prefix is its own word", () => {
  assert.equal(normalizeUtterance("Schick's ab."), "schick s ab ");
  assert.equal(normalizeUtterance("LÖSCH DEN TERMIN!"), "lösch den termin ");
});

test("stems anchored here match umlaut-initial words, which `\\b` cannot", () => {
  // The trap this module exists for: `\b` is defined in terms of ASCII `\w`, so
  // there is no boundary before "ä" and `\bänder` never matches at all.
  assert.equal(/\bänder/u.test("bitte ändere das"), false);
  assert.equal(verb(`änder${STEM_REST}`).test("bitte ändere das"), true);
});

test("a stem wildcard does not stop at the first umlaut", () => {
  // `\w*` would match "Anderungswunsch" but give up on "Änderungswünsche".
  assert.equal(verb(`änderungsw${STEM_REST}`).test("änderungswünsche"), true);
});

test("particles match whole words only", () => {
  const auf = new RegExp(particle("auf"), "u");
  assert.equal(auf.test("leg auf"), true);
  assert.equal(auf.test("aufgabe"), false);
  assert.equal(auf.test("darauf"), false);
});

test("a request is only explicit when no veto applies", () => {
  const gate = {
    patterns: [verb(`lösch${STEM_REST}`)],
    vetoes: (_text: string, before: string) =>
      new RegExp(`${particle("nicht")}${GAP}$`, "u").test(before),
  };
  assert.equal(isExplicitRequest("Lösch den Termin.", gate), true);
  assert.equal(isExplicitRequest("Bitte nicht löschen.", gate), false);
  assert.equal(isExplicitRequest("Was steht heute an?", gate), false);
});

test("the veto sees only the text ahead of the match", () => {
  // A refusal that lands after the verb must not retroactively cancel it for a
  // gate that reads negation positionally — that is what `before` is for.
  const gate = {
    patterns: [verb(`sende${STEM_REST}`)],
    vetoes: (_text: string, before: string) => before.includes("nicht"),
  };
  assert.equal(isExplicitRequest("Sende das, nicht später.", gate), true);
  assert.equal(isExplicitRequest("Bitte nicht senden.", gate), false);
});

test("an empty utterance is not consent", () => {
  // The realistic failure mode: a tool result or mail body drives the call
  // while the user's own turn said nothing that asks for a write.
  const gate = { patterns: [verb(`lösch${STEM_REST}`)], vetoes: () => false };
  assert.equal(isExplicitRequest("", gate), false);
  assert.equal(isExplicitRequest("   ", gate), false);
});
