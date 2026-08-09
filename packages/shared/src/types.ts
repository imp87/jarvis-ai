import { z } from "zod";

// ---------------------------------------------------------------------------
// Unified conversation model
//
// This is the vocabulary every component speaks: channel adapters, the agent
// loop, the LLM provider adapters and the database. Provider-specific shapes
// (Anthropic content blocks, OpenAI tool_calls) never leave their adapter.
// ---------------------------------------------------------------------------

export const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_call"),
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal("tool_result"),
    toolCallId: z.string(),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
  /** Reasoning summary, when the provider returns one. Never sent back verbatim. */
  z.object({ type: z.literal("thinking"), text: z.string() }),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const llmMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(contentBlockSchema),
  /**
   * Provider-native content, kept verbatim so the next turn can replay it
   * unchanged when the same provider handles it. This exists because reasoning
   * blocks carry signatures that must not be reconstructed — echoing back a
   * lossy re-serialisation is rejected by the API. Opaque by design: nothing
   * outside the owning provider adapter may read it.
   */
  providerEcho: z
    .object({ provider: z.string(), blocks: z.unknown() })
    .optional(),
});
export type LlmMessage = z.infer<typeof llmMessageSchema>;

export function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

export function userText(text: string): LlmMessage {
  return { role: "user", content: [textBlock(text)] };
}

/** Flatten a message's text blocks — for logging, transcripts and embeddings. */
export function messageText(message: LlmMessage): string {
  return message.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  /** Unique across all sources. Convention: `<source>__<name>`, e.g. `mcp_gmail__list_messages`. */
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset) for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** A tool the agent can call. `source` drives auditing and the policy layer. */
export interface ExecutableTool extends ToolDefinition {
  source: "builtin" | "mcp" | "connector";
  /** True for anything that costs money, sends messages or changes external state. */
  sideEffects: boolean;
  /**
   * Restricts the tool to these channels. Omit to offer it everywhere.
   *
   * Hanging up is meaningless in a Telegram chat, and a model that can see a
   * tool it cannot use will try it anyway — so such tools are withheld rather
   * than left to fail.
   */
  channels?: ChannelName[];
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  conversationId: string;
  userId: string;
  /** Set when the call originated from a channel adapter. */
  channel?: ChannelName;
  /** The user's current utterance, for tools that require explicit consent. */
  lastUserText?: string;
  /** Where a tool records a request for the caller of the turn. See `TurnSignals`. */
  signals?: TurnSignals;
}

/**
 * Out-of-band requests a tool makes of whoever is running the turn.
 *
 * A tool cannot hang up a phone call itself — it runs inside the orchestrator,
 * which holds no audio. It records the intent here instead, the agent loop
 * returns it with the reply, and the voice pipeline acts on it once the reply
 * has actually been spoken. Ending the call from inside the tool would cut the
 * agent off mid-goodbye.
 */
export interface TurnSignals {
  endCall?: { reason: string };
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const channelNameSchema = z.enum([
  "telegram",
  "discord",
  "voice_call",
  "wake_word",
  "email",
  "api",
]);
export type ChannelName = z.infer<typeof channelNameSchema>;

/**
 * What a channel adapter POSTs to the orchestrator. The orchestrator knows
 * nothing about Telegram or Discord — only this envelope.
 */
export const inboundMessageSchema = z.object({
  channel: channelNameSchema,
  /** Stable per-channel user id (Telegram user id, Discord snowflake, caller number). */
  channelUserId: z.string().min(1),
  /** Plain text. Voice notes are transcribed by the adapter before they get here. */
  text: z.string().min(1).max(32_000),
  /** Optional explicit thread. Omit to continue the user's most recent conversation. */
  conversationId: z.string().uuid().optional(),
  /** Adapter-specific extras (message id, chat id, attachment refs) for the reply path. */
  metadata: z.record(z.unknown()).default({}),
  /** Adapter hint: user prefers a spoken reply on this channel. */
  preferVoiceReply: z.boolean().default(false),
});
export type InboundMessage = z.infer<typeof inboundMessageSchema>;

export interface OutboundMessage {
  channel: ChannelName;
  channelUserId: string;
  conversationId: string;
  text: string;
  /** Adapter renders this as a voice note if it can. */
  asVoice: boolean;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Outbound call trigger (component 1) — the payload the voice pipeline receives
// ---------------------------------------------------------------------------

export const callRequestSchema = z.object({
  toNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, "must be E.164, e.g. +4915112345678"),
  /** Short human-readable reason, surfaced in the call log and the UI. */
  reason: z.string().min(1).max(500),
  /** Context handed to the voice agent as its opening system context. */
  context: z.string().min(1).max(8_000),
  conversationId: z.string().uuid().optional(),
  /** Bypasses quiet hours. Requires an explicit operator action — never set by the classifier. */
  urgent: z.boolean().default(false),
});
export type CallRequest = z.infer<typeof callRequestSchema>;
