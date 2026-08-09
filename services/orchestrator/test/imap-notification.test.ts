import assert from "node:assert/strict";
import test from "node:test";
import { mailDecisionFromAgentReply } from "../src/services/imap.js";

test("IMAP only routes an explicit, complete classifier decision", () => {
  assert.equal(mailDecisionFromAgentReply("IGNORE"), null);
  assert.equal(mailDecisionFromAgentReply("This looks important"), null);
  assert.equal(mailDecisionFromAgentReply("ACTION: URGENT\nSUMMARY:"), null);
  assert.deepEqual(
    mailDecisionFromAgentReply("ACTION: URGENT\nSUMMARY: Rechnung ist morgen fällig.\nDRAFT: Ich kümmere mich heute darum."),
    { priority: "URGENT", summary: "Rechnung ist morgen fällig.", draft: "Ich kümmere mich heute darum." },
  );
  assert.deepEqual(
    mailDecisionFromAgentReply("ACTION: IGNORE\nSUMMARY: \nDRAFT:"),
    { priority: "IGNORE", summary: "", draft: null },
  );
});
