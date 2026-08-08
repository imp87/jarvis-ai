import type { ContentBlock, LlmMessage, ToolDefinition } from "@jarvis/shared";

/**
 * Provider-neutral reasoning effort. Adapters map this onto whatever their
 * provider actually supports (Anthropic: output_config.effort; OpenAI-style
 * endpoints: reasoning_effort, or ignored entirely).
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatRequest {
  system?: string;
  messages: LlmMessage[];
  tools?: ToolDefinition[];
  /** Total output ceiling. On reasoning models this covers thinking + text. */
  maxTokens?: number;
  /**
   * Ignored by providers that reject sampling parameters (every current
   * Anthropic reasoning model does). Do not rely on it for determinism.
   */
  temperature?: number;
  effort?: Effort;
  /** Overrides the profile's model. Mostly for one-off experiments. */
  model?: string;
  signal?: AbortSignal;
}

export type StopReason =
  | "end_turn"
  | "tool_call"
  | "max_tokens"
  | "refusal"
  | "other";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ChatResponse {
  provider: string;
  model: string;
  content: ContentBlock[];
  stopReason: StopReason;
  usage: TokenUsage;
  /**
   * Provider-native content to replay on the next turn. Persist it alongside
   * the message and hand it back unchanged — see `LlmMessage.providerEcho`.
   */
  providerEcho?: { provider: string; blocks: unknown };
  /** Populated when stopReason is "refusal". */
  refusal?: { category: string | null; explanation?: string };
}

export interface ChatProvider {
  readonly name: string;
  readonly defaultModel: string;
  /** False disqualifies the provider from any request that carries tools. */
  readonly supportsTools: boolean;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export function toolCallsOf(
  content: ContentBlock[],
): Array<Extract<ContentBlock, { type: "tool_call" }>> {
  return content.filter(
    (b): b is Extract<ContentBlock, { type: "tool_call" }> => b.type === "tool_call",
  );
}

export function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
