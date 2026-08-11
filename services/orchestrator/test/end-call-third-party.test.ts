import assert from "node:assert/strict";
import test from "node:test";
import type { ContactRepository } from "@jarvis/db";
import type { ExecutableTool, ToolContext } from "@jarvis/shared";
import { buildBuiltinTools } from "../src/agent/tools/builtin.js";

const deps = {
  memory: {} as never,
  calls: {} as never,
  contacts: {} as never as ContactRepository,
  mandates: {} as never,
  ownerPhoneNumber: "+4917612345678",
  outboundCallsEnabled: true,
};

const endCall = buildBuiltinTools(deps).find((t) => t.name === "end_call") as ExecutableTool;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: "c1",
    userId: "u1",
    channel: "voice_call",
    signals: {},
    ...overrides,
  } as ToolContext;
}

test("end_call survives the side-effect filter that a third-party turn applies", () => {
  // Every other side effect is switched off on a stranger's turn. Withholding
  // this one too left the agent unable to end a call it had placed itself —
  // it waited on the callee or on the idle timer.
  assert.equal(endCall.sideEffects, true);
  assert.equal(endCall.confinedToConversation, true);
});

test("on an owner call the hangup still needs their explicit request", () => {
  const signals = {};
  return endCall
    .execute({ reason: "done" }, ctx({ lastUserText: "Danke.", signals }))
    .then((result) => {
      assert.equal(result.isError, true);
      assert.deepEqual(signals, {}, "no hangup may be signalled");
    });
});

test("an owner who asks is obeyed", async () => {
  const signals: { endCall?: { reason: string } } = {};
  const result = await endCall.execute(
    { reason: "done" },
    ctx({ lastUserText: "Leg bitte auf.", signals }),
  );
  assert.equal(result.isError, undefined);
  assert.equal(signals.endCall?.reason, "done");
});

test("on a call we placed, the callee's words are not the gate", async () => {
  // The gate asks "did the owner just ask me to hang up" and reads the current
  // utterance. On an outbound call that text is a stranger's, so the question
  // is put to the wrong person and the answer is always no.
  const signals: { endCall?: { reason: string } } = {};
  const result = await endCall.execute(
    { reason: "errand done" },
    ctx({ lastUserText: "Hallo?", counterpart: "third_party", signals }),
  );
  assert.equal(result.isError, undefined);
  assert.equal(signals.endCall?.reason, "errand done");
});

test("outside a live call it refuses rather than claiming success", async () => {
  const result = await endCall.execute({ reason: "x" }, ctx({ signals: undefined }));
  assert.equal(result.isError, true);
  assert.match(result.content, /no call to end/i);
});
