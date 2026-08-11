import { callRequestSchema, type ExecutableTool, type ToolResult } from "@jarvis/shared";
import { isExplicitRequest } from "../consent.js";
import type { MemoryService } from "../../services/memory.js";
import type { CallService } from "../../services/calls.js";

/**
 * A refusal anywhere near a hangup verb. Unlike the calendar gate this looks at
 * the whole utterance rather than only the run-up, because "leg nicht auf" puts
 * the refusal between the verb and its prefix.
 */
const NEGATED_HANGUP =
  /\b(?:nicht|kein(?:en|e|er|es)?|niemals|nie|bloß nicht|auf keinen fall)\b[\s\S]{0,40}\b(?:aufleg\w*|beend\w*|schluss\s+mach\w*)\b/u;

const HANGUP_REQUESTS: readonly RegExp[] = [
  // Filler words routinely land between the verb and its detached prefix
  // ("lege jetzt auf"). Only known fillers are allowed through, so that
  // "leg die Unterlagen auf den Tisch" still does not end the call.
  /\b(?:leg(?:e|st|t)?\s+(?:(?:bitte|jetzt|dann|mal|einfach|gleich|schon|ruhig|nun)\s+){0,3}auf\b|aufleg\w*)\b/u,
  /\b(?:beend(?:e|et)?\s+(?:bitte\s+)?(?:den\s+)?(?:anruf|das\s+gespräch)|beend\w*\s+(?:bitte\s+)?(?:den\s+)?(?:anruf|das\s+gespräch))\b/u,
  /\b(?:tschüss|tschuess|auf\s+wiedersehen|bis\s+bald)\b/u,
];

/** End a call only on an unambiguous, affirmative signal from the caller. */
export function isExplicitHangupRequest(value: string): boolean {
  return isExplicitRequest(value, {
    patterns: HANGUP_REQUESTS,
    vetoes: (text) => NEGATED_HANGUP.test(text),
  });
}

/**
 * Tools the orchestrator implements itself. Everything else reaches the agent
 * through MCP or the connector registry.
 */
export function buildBuiltinTools(deps: {
  memory: MemoryService;
  calls: CallService;
  ownerPhoneNumber?: string | undefined;
}): ExecutableTool[] {
  const tools: ExecutableTool[] = [
    {
      name: "memory_search",
      description:
        "Search things the user told you in earlier conversations, plus call transcripts and " +
        "email summaries. Use it when the answer depends on something said or decided in a " +
        "past conversation.\n\n" +
        // Without this, "Projektnotizen"/"notes" pulls the model here even when
        // the user plainly means a file, because both read as "notes".
        "This does NOT contain files or documents. If the user refers to a file, a directory, " +
        "a document or anything with a name and an extension, use the file tools instead — " +
        "even when they call it a note.",
      source: "builtin",
      sideEffects: false,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, in natural language." },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 6 },
        },
        required: ["query"],
      },
      async execute(args, ctx): Promise<ToolResult> {
        const query = String(args["query"] ?? "");
        const limit = Number(args["limit"] ?? 6);
        const hits = await deps.memory.search({ userId: ctx.userId, query, limit });
        if (hits.length === 0) return { content: "No matching memories." };
        return {
          content: hits
            .map(
              (hit, i) =>
                `${i + 1}. [${hit.kind}] (similarity ${hit.similarity.toFixed(2)}) ${hit.content}`,
            )
            .join("\n"),
        };
      },
    },

    {
      name: "memory_save",
      description:
        "Store a fact, preference or decision in long-term memory so it is available in future " +
        "conversations on any channel. Save durable facts, not conversational chatter.",
      source: "builtin",
      sideEffects: false,
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The fact to remember, written as a self-contained sentence.",
          },
        },
        required: ["content"],
      },
      async execute(args, ctx): Promise<ToolResult> {
        const content = String(args["content"] ?? "").trim();
        if (content.length === 0) return { content: "Nothing to save.", isError: true };
        const id = await deps.memory.remember({
          userId: ctx.userId,
          kind: "note",
          content,
          sourceRef: { conversationId: ctx.conversationId },
        });
        return { content: `Saved (id ${id}).` };
      },
    },
    {
      name: "end_call",
      description:
        "Hang up the phone call only when the caller explicitly asks to hang up or clearly says " +
        "goodbye. A thank-you, a completed answer, or delivering an outgoing-call message is " +
        "NOT permission to end the call. When unsure, do not call this tool.\n\n" +
        "Call this BEFORE your closing words, not after. Nothing is cut off: the tool returns, " +
        "you then say your goodbye as normal, it is spoken in full, and the line closes after " +
        "it.",
      source: "builtin",
      // Ends a live call. Irreversible for that conversation.
      sideEffects: true,
      // Withheld on every other channel; there is nothing to hang up in a chat.
      channels: ["voice_call"],
      inputSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "One short line on why the call is over, for the call log.",
          },
        },
        required: ["reason"],
      },
      async execute(args, ctx): Promise<ToolResult> {
        if (!ctx.signals) {
          // Reached when something ran the agent outside a live call — the admin
          // UI's dry run, for instance. Better to say so than to claim success.
          return {
            content: "There is no call to end in this context.",
            isError: true,
          };
        }
        if (!isExplicitHangupRequest(ctx.lastUserText ?? "")) {
          return {
            content:
              "The caller has not explicitly asked to end the call. Keep it open and respond " +
              "normally; do not try end_call again unless they clearly say goodbye or ask to hang up.",
            isError: true,
          };
        }
        const reason = String(args["reason"] ?? "").trim() || "conversation finished";
        ctx.signals.endCall = { reason };
        return {
          content:
            "Ready to hang up. Now say your goodbye — it is spoken in full and the line " +
            "closes afterwards. Keep it to one short sentence.",
        };
      },
    },
  ];

  // Only offer the call tool when there is a number to dial. An agent that can
  // see a tool it cannot use will try it anyway.
  if (deps.ownerPhoneNumber) {
    tools.push({
      name: "place_phone_call",
      description:
        "Call the owner's phone and speak to them. Only for things that genuinely cannot wait " +
        "for a chat message. Calls are subject to quiet hours and a strict hourly budget; " +
        "if the policy blocks the call you will be told so and should send a message instead.",
      source: "builtin",
      // Costs money, rings a phone, wakes a human.
      sideEffects: true,
      // Calling from an active call can create an infinite call-back loop.
      channels: ["telegram", "discord", "email", "api"],
      inputSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "One line on why this warrants a call, for the audit log.",
          },
          context: {
            type: "string",
            description:
              "Exact German first sentence for the recipient. State the reason or reminder itself, " +
              "for example: 'Master, Erinnerung: Sie wollten jetzt den Müll rausbringen.' Never " +
              "use a generic greeting or ask what they need; this is an outbound call.",
          },
        },
        required: ["reason", "context"],
      },
      async execute(args, ctx): Promise<ToolResult> {
        const parsed = callRequestSchema.safeParse({
          toNumber: deps.ownerPhoneNumber,
          reason: args["reason"],
          context: args["context"],
          conversationId: ctx.conversationId,
          // The model never gets to declare its own request urgent — that flag
          // bypasses quiet hours and is reserved for operator-triggered calls.
          urgent: false,
        });
        if (!parsed.success) {
          return { content: `Invalid call request: ${parsed.error.message}`, isError: true };
        }
        const outcome = await deps.calls.requestCall(parsed.data);
        if (outcome.placed) return { content: `Call placed (id ${outcome.call.id}).` };
        return {
          // Phrased as a momentary verdict on purpose. The plain form ("daily
          // call budget exhausted (8/8)") stays in the conversation and reads
          // like a standing fact, so the model later refuses to place a call it
          // was never asked to attempt — the budget may have been raised, the
          // day may have rolled over, or quiet hours may have ended since.
          content:
            `Not placed right now: ${outcome.reason}. This was the situation at ` +
            `${new Date().toISOString()} and can change at any time. Never treat it as a ` +
            `standing limit or repeat it from an earlier turn — if asked again, call this ` +
            `tool again and report what it says then.`,
          isError: true,
        };
      },
    });
  }

  return tools;
}
