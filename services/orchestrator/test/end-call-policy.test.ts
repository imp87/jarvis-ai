import assert from "node:assert/strict";
import test from "node:test";
import { isExplicitHangupRequest } from "../src/agent/tools/builtin.js";

test("end_call only accepts clear affirmative hangup signals", () => {
  assert.equal(isExplicitHangupRequest("Danke."), false);
  assert.equal(isExplicitHangupRequest("Hörst du mich gut?"), false);
  assert.equal(isExplicitHangupRequest("Ich möchte nicht, dass du einfach auflegst."), false);
  assert.equal(isExplicitHangupRequest("Leg bitte auf."), true);
  assert.equal(isExplicitHangupRequest("Danke, tschüss."), true);
  assert.equal(isExplicitHangupRequest("Beende bitte den Anruf."), true);
});

test("end_call tolerates filler words between the verb and its prefix", () => {
  assert.equal(isExplicitHangupRequest("Ich ignoriere es und lege jetzt auf."), true);
  assert.equal(isExplicitHangupRequest("Leg dann einfach auf."), true);
  assert.equal(isExplicitHangupRequest("Du kannst auflegen, danke."), true);
  // A filler list, not a wildcard: an unrelated object must not end the call.
  assert.equal(isExplicitHangupRequest("Leg die Unterlagen auf den Tisch."), false);
});
