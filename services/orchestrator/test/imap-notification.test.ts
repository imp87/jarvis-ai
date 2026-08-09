import assert from "node:assert/strict";
import test from "node:test";
import { notificationFromAgentReply } from "../src/services/imap.js";

test("IMAP only notifies for an explicit classifier decision", () => {
  assert.equal(notificationFromAgentReply("IGNORE"), null);
  assert.equal(notificationFromAgentReply("This looks important"), null);
  assert.equal(notificationFromAgentReply("NOTIFY: Rechnung ist morgen fällig."), "Rechnung ist morgen fällig.");
  assert.equal(notificationFromAgentReply("\n NOTIFY: Bitte Rückmeldung bis Freitag. \n"), "Bitte Rückmeldung bis Freitag.");
});
