import { callRequestSchema, type ExecutableTool, type ToolResult } from "@jarvis/shared";
import type { MemoryService } from "../../services/memory.js";
import type { CallService } from "../../services/calls.js";

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
        "Hang up the phone call you are on. Use it as soon as the conversation is finished — " +
        "the other person has said goodbye, you have delivered what you called about, or they " +
        "ask you to hang up.\n\n" +
        "Call this BEFORE your closing words, not after. Nothing is cut off: the tool returns, " +
        "you then say your goodbye as normal, it is spoken in full, and the line closes after " +
        "it. Saying goodbye without calling this leaves the other person listening to silence " +
        "until the call times out.\n\n" +
        "Do not call it while anything is still unresolved — there is no way to call back into " +
        "the same conversation.",
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
              "What to say. The voice agent opens the conversation with this as its briefing.",
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
        return outcome.placed
          ? { content: `Call placed (id ${outcome.call.id}).` }
          : { content: `Call not placed: ${outcome.reason}`, isError: true };
      },
    });
  }

  return tools;
}
