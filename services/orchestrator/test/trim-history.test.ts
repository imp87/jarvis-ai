import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LlmMessage } from "@jarvis/shared";
import { trimHistory } from "../src/agent/loop.js";

/**
 * Guards the fix for the failure that took down a live phone call: a 107 KB
 * `list_tables` result sat in the conversation and was replayed on every turn,
 * pushing each request to ~84k input tokens until the provider's per-minute
 * token budget was exhausted.
 */

const text = (role: LlmMessage["role"], body: string): LlmMessage => ({
  role,
  content: [{ type: "text", text: body }],
});

const toolCall = (id: string): LlmMessage => ({
  role: "assistant",
  content: [{ type: "tool_call", id, name: "some_tool", arguments: {} }],
});

const toolResult = (id: string, body: string): LlmMessage => ({
  role: "user",
  content: [{ type: "tool_result", toolCallId: id, content: body }],
});

describe("trimHistory", () => {
  it("keeps everything when it already fits", () => {
    const history = [text("user", "hallo"), text("assistant", "hi")];
    assert.deepEqual(trimHistory(history, 10_000), history);
  });

  it("drops the oldest messages until the budget is met", () => {
    const history = [
      text("user", "x".repeat(5_000)),
      text("assistant", "y".repeat(5_000)),
      text("user", "was ist das wetter"),
    ];
    // Two of these fit in 6 000; the third would take it to ~10 000.
    const kept = trimHistory(history, 6_000);
    assert.deepEqual(kept, history.slice(1));
  });

  it("never drops the newest message, however large", () => {
    // Otherwise the turn the user just took would vanish and the model would
    // answer the previous question again.
    const history = [text("user", "z".repeat(50_000))];
    assert.deepEqual(trimHistory(history, 1_000), history);
  });

  it("drops a tool result whose tool call was trimmed away", () => {
    // Every provider rejects a tool_result with no preceding tool_call, so a
    // size-only trim would turn a large history into a 400.
    const history = [
      toolCall("call_1"),
      toolResult("call_1", "r".repeat(9_000)),
      text("user", "und weiter?"),
    ];
    // Chosen to land between the two: the result still fits, its call does not.
    // That is the only window in which an orphan can be produced at all.
    const kept = trimHistory(history, 9_100);

    assert.ok(
      !kept.some((m) => typeof m.content !== "string" && m.content.some((b) => b.type === "tool_result")),
      "an orphaned tool_result survived the trim",
    );
    assert.deepEqual(kept, [history[2]]);
  });

  it("keeps a tool call together with its result once the older turn is dropped", () => {
    const history = [
      text("user", "a".repeat(1_000)),
      toolCall("call_1"),
      toolResult("call_1", "kurz"),
      text("assistant", "fertig"),
    ];
    // Big enough for the tool pair and the reply, too small for the old turn.
    const kept = trimHistory(history, 900);
    assert.deepEqual(kept, history.slice(1), "the call/result pair must survive together");
  });

  it("survives the real shape: one oversized result among small messages", () => {
    const history = [
      text("user", "zeig mir die tabellen"),
      toolCall("call_1"),
      toolResult("call_1", "{".repeat(107_430)),
      text("assistant", "hier sind sie"),
      text("user", "ruf mich an"),
    ];
    const kept = trimHistory(history, 48_000);
    const size = kept.reduce((sum, m) => sum + JSON.stringify(m.content).length, 0);

    assert.ok(size < 48_000, `history still ${size} chars`);
    assert.deepEqual(kept, history.slice(3));
  });
});
