import { ProviderError, type ContentBlock, type LlmMessage } from "@jarvis/shared";
import type {
  ChatProvider,
  ChatRequest,
  ChatResponse,
  EmbeddingProvider,
  StopReason,
} from "../types.js";

/**
 * One adapter for every endpoint that speaks the OpenAI chat-completions
 * shape. That is OpenAI itself, Ollama (`/v1`), vLLM, LM Studio, llama.cpp's
 * server and most other local runtimes — which is exactly why the internal
 * interface is modelled on this API: it is the de-facto standard.
 *
 * Tool calling is the hard requirement for a local model here. Not every model
 * an Ollama install can run supports it reliably; prefer function-calling
 * natives (Llama 3.1+, Qwen 2.5+) and verify with a real tool round-trip
 * before routing anything important at it.
 */
export interface OpenAICompatibleOptions {
  /** Provider label used in logs, routing config and the message audit trail. */
  name: string;
  /** Root of the OpenAI-compatible API, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  supportsTools?: boolean;
  timeoutMs?: number;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIChatResponse {
  model: string;
  choices: Array<{
    message: OpenAIChatMessage;
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatibleProvider implements ChatProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly supportsTools: boolean;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly defaultMaxTokens: number;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.defaultModel = options.model;
    this.supportsTools = options.supportsTools ?? true;
    this.defaultMaxTokens = options.maxTokens ?? 4096;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model ?? this.defaultModel;
    const body: Record<string, unknown> = {
      model,
      messages: toOpenAIMessages(request.system, request.messages),
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
    };
    if (request.temperature !== undefined) body["temperature"] = request.temperature;
    if (request.tools?.length && this.supportsTools) {
      body["tools"] = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
      body["tool_choice"] = "auto";
    }

    const payload = await this.post<OpenAIChatResponse>("/chat/completions", body, request.signal);
    const choice = payload.choices[0];
    if (!choice) {
      throw new ProviderError("response contained no choices", this.name);
    }

    return {
      provider: this.name,
      model: payload.model ?? model,
      content: fromOpenAIMessage(choice.message),
      stopReason: mapFinishReason(choice.finish_reason, choice.message),
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      },
    };
  }

  private async post<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    signal?.addEventListener("abort", () => controller.abort(), { once: true });

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new ProviderError(
          `${this.name} ${response.status}: ${text.slice(0, 500)}`,
          this.name,
          { status: response.status },
        );
      }
      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new ProviderError(`${this.name} request timed out`, this.name);
      }
      throw new ProviderError(
        `${this.name} request failed: ${(err as Error).message}`,
        this.name,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export class OpenAICompatibleEmbeddings implements EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(options: {
    name: string;
    baseUrl: string;
    apiKey?: string;
    model: string;
    dimensions: number;
  }) {
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dimensions = options.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(
        `${this.name} embeddings ${response.status}: ${text.slice(0, 500)}`,
        this.name,
      );
    }
    const payload = (await response.json()) as {
      data: Array<{ embedding: number[]; index?: number }>;
    };
    // Some servers return results out of order; index is authoritative when present.
    const sorted = [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = sorted.map((d) => d.embedding);

    const first = vectors[0];
    if (first && first.length !== this.dimensions) {
      // Silently storing a wrong-width vector fails much later, at query time,
      // with a confusing Postgres error. Fail here instead.
      throw new ProviderError(
        `${this.name} returned ${first.length}-dimensional vectors but EMBEDDING_DIM is ${this.dimensions}`,
        this.name,
      );
    }
    return vectors;
  }
}

function mapFinishReason(reason: string | null, message: OpenAIChatMessage): StopReason {
  if (message.tool_calls?.length) return "tool_call";
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_call";
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

function fromOpenAIMessage(message: OpenAIChatMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (message.content) blocks.push({ type: "text", text: message.content });
  for (const call of message.tool_calls ?? []) {
    let args: Record<string, unknown> = {};
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      // A model that emits malformed JSON should get a tool error back rather
      // than crashing the loop; surface it as an empty-args call and let the
      // tool's schema validation produce the message.
      args = { __malformed_arguments: call.function.arguments };
    }
    blocks.push({ type: "tool_call", id: call.id, name: call.function.name, arguments: args });
  }
  return blocks;
}

function toOpenAIMessages(
  system: string | undefined,
  messages: LlmMessage[],
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const message of messages) {
    // Tool results are their own role in this API, so a unified user message
    // holding tool_result blocks expands into several messages.
    const toolResults = message.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
    );
    for (const result of toolResults) {
      out.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: result.isError ? `ERROR: ${result.content}` : result.content,
      });
    }

    const text = message.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const toolCalls = message.content
      .filter((b): b is Extract<ContentBlock, { type: "tool_call" }> => b.type === "tool_call")
      .map<OpenAIToolCall>((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.arguments) },
      }));

    if (text.trim().length === 0 && toolCalls.length === 0) continue;

    out.push({
      role: message.role,
      content: text.length > 0 ? text : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  return out;
}
