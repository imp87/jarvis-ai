import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type ContentBlock, type LlmMessage } from "@jarvis/shared";
import type { ChatProvider, ChatRequest, ChatResponse, StopReason } from "../types.js";

const PROVIDER = "anthropic";

/**
 * Non-streaming requests risk an HTTP timeout above roughly this many output
 * tokens, so anything larger goes through the streaming endpoint and is
 * collected with finalMessage().
 */
const STREAM_THRESHOLD = 16_000;

/**
 * Current reasoning models reject `temperature` / `top_p` / `top_k` with a 400.
 * The abstraction still accepts a temperature because other providers use it —
 * we drop it here rather than making every caller know which model is which.
 */
const REJECTS_SAMPLING_PARAMS = [
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-mythos-5",
];

function rejectsSamplingParams(model: string): boolean {
  return REJECTS_SAMPLING_PARAMS.some((prefix) => model.startsWith(prefix));
}

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Defaults to Claude Opus 5. */
  model?: string;
  maxTokens?: number;
  /** Set "summarized" to surface reasoning summaries; the API default omits them. */
  thinkingDisplay?: "omitted" | "summarized";
  baseUrl?: string;
}

export class AnthropicProvider implements ChatProvider {
  readonly name = PROVIDER;
  readonly defaultModel: string;
  readonly supportsTools = true;

  private readonly client: Anthropic;
  private readonly defaultMaxTokens: number;
  private readonly thinkingDisplay: "omitted" | "summarized";

  constructor(options: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    });
    this.defaultModel = options.model ?? "claude-opus-5";
    this.defaultMaxTokens = options.maxTokens ?? 16_000;
    this.thinkingDisplay = options.thinkingDisplay ?? "omitted";
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model ?? this.defaultModel;
    const maxTokens = request.maxTokens ?? this.defaultMaxTokens;

    const params: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: toAnthropicMessages(request.messages),
      // Adaptive thinking: the model decides how much to reason per request.
      // There is no token budget to tune — depth is controlled by `effort`.
      thinking: { type: "adaptive", display: this.thinkingDisplay },
    };

    if (request.system) params["system"] = request.system;
    if (request.tools?.length) {
      params["tools"] = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }
    if (request.effort) params["output_config"] = { effort: request.effort };
    if (request.temperature !== undefined && !rejectsSamplingParams(model)) {
      params["temperature"] = request.temperature;
    }

    let message: Anthropic.Message;
    try {
      // Cast at the boundary: `thinking.display` and `output_config` are newer
      // than some SDK typings, and pinning the whole request to a struct we
      // cannot verify at build time would be worse than one narrow cast.
      if (maxTokens > STREAM_THRESHOLD) {
        message = await this.client.messages
          .stream(params as unknown as Anthropic.MessageStreamParams, {
            ...(request.signal ? { signal: request.signal } : {}),
          })
          .finalMessage();
      } else {
        message = await this.client.messages.create(
          params as unknown as Anthropic.MessageCreateParamsNonStreaming,
          { ...(request.signal ? { signal: request.signal } : {}) },
        );
      }
    } catch (err) {
      throw wrapError(err);
    }

    // Check stop_reason before touching content: on a refusal the content array
    // is empty (pre-output) or a discarded partial (mid-stream).
    const stopReason = mapStopReason(message.stop_reason);
    const content = fromAnthropicContent(message.content);

    const response: ChatResponse = {
      provider: PROVIDER,
      model: message.model,
      content,
      stopReason,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        ...(message.usage.cache_read_input_tokens != null
          ? { cacheReadTokens: message.usage.cache_read_input_tokens }
          : {}),
        ...(message.usage.cache_creation_input_tokens != null
          ? { cacheWriteTokens: message.usage.cache_creation_input_tokens }
          : {}),
      },
      providerEcho: { provider: PROVIDER, blocks: message.content },
    };

    if (stopReason === "refusal") {
      const details = (message as { stop_details?: { category?: string; explanation?: string } })
        .stop_details;
      response.refusal = {
        category: details?.category ?? null,
        ...(details?.explanation ? { explanation: details.explanation } : {}),
      };
    }

    return response;
  }
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_call";
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function fromAnthropicContent(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        out.push({ type: "text", text: block.text });
        break;
      case "thinking":
        // Empty unless thinkingDisplay is "summarized"; keep it only when there
        // is something to show. The signed original lives in providerEcho.
        if (block.thinking) out.push({ type: "thinking", text: block.thinking });
        break;
      case "tool_use":
        out.push({
          type: "tool_call",
          id: block.id,
          name: block.name,
          arguments: (block.input ?? {}) as Record<string, unknown>,
        });
        break;
      default:
        // redacted_thinking and server-tool blocks carry nothing the agent loop
        // acts on; they survive verbatim in providerEcho.
        break;
    }
  }
  return out;
}

function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    // Replay provider-native content verbatim. Reasoning blocks are signed and
    // must not be reconstructed from our lossy unified representation.
    if (
      message.role === "assistant" &&
      message.providerEcho?.provider === PROVIDER &&
      Array.isArray(message.providerEcho.blocks) &&
      message.providerEcho.blocks.length > 0
    ) {
      out.push({
        role: "assistant",
        content: message.providerEcho.blocks as Anthropic.ContentBlockParam[],
      });
      continue;
    }

    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          if (block.text.trim().length > 0) blocks.push({ type: "text", text: block.text });
          break;
        case "tool_call":
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments,
          });
          break;
        case "tool_result":
          blocks.push({
            type: "tool_result",
            tool_use_id: block.toolCallId,
            content: block.content,
            ...(block.isError ? { is_error: true } : {}),
          });
          break;
        case "thinking":
          // Dropped on purpose: without its signature the API would reject it.
          break;
      }
    }

    // The API rejects a message with an empty content array.
    if (blocks.length > 0) out.push({ role: message.role, content: blocks });
  }

  return out;
}

function wrapError(err: unknown): ProviderError {
  if (err instanceof Anthropic.APIError) {
    return new ProviderError(
      `anthropic ${err.status ?? "?"}: ${err.message}`,
      PROVIDER,
      { status: err.status, type: (err as { type?: string }).type },
    );
  }
  return new ProviderError(`anthropic request failed: ${(err as Error).message}`, PROVIDER);
}
