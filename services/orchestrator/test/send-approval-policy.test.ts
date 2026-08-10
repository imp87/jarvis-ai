import assert from "node:assert/strict";
import test from "node:test";
import { isExplicitSendApproval } from "../src/agent/tools/imap.js";

test("send_reply_draft accepts the separable verb forms used on the phone", () => {
  // Every one of these was spoken on a real call; only the first was accepted
  // before, which left the agent asking for the draft UUID out loud.
  assert.equal(isExplicitSendApproval("Schick die E-Mail jetzt ab."), true);
  assert.equal(isExplicitSendApproval("Ja, send ihn ab."), true);
  assert.equal(isExplicitSendApproval("Du hast ausdrücklich meine Freigabe erteilt."), true);
  assert.equal(isExplicitSendApproval("Schick das raus."), true);
  assert.equal(isExplicitSendApproval("Sende den Entwurf."), true);
  assert.equal(isExplicitSendApproval("Du kannst ihn abschicken."), true);
});

test("send_reply_draft still requires an unambiguous release", () => {
  assert.equal(isExplicitSendApproval("Ja."), false);
  assert.equal(isExplicitSendApproval("Klingt gut."), false);
  assert.equal(isExplicitSendApproval("Lies mir den Entwurf nochmal vor."), false);
  assert.equal(isExplicitSendApproval(""), false);
});

test("send_reply_draft treats a refusal near the verb as a non-approval", () => {
  assert.equal(isExplicitSendApproval("Sende das bitte nicht."), false);
  assert.equal(isExplicitSendApproval("Nein, nicht abschicken."), false);
  assert.equal(isExplicitSendApproval("Warte noch mit dem Senden."), false);
});

test("send_reply_draft ignores past tense and unrelated words", () => {
  assert.equal(isExplicitSendApproval("Hast du die Sendung schon bekommen?"), false);
  assert.equal(isExplicitSendApproval("Die Mail wurde gestern verschickt."), false);
});
