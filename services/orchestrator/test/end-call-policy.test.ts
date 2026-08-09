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
