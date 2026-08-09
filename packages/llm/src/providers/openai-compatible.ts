import { ProviderError, type ContentBlock, type LlmMessage, type Logger } from "@jarvis/shared";
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
  /** Retries for 429 and 5xx. Default 2. */
  maxRetries?: number;
  /** Upper bound on a single retry wait, however long the provider asks for. */
  maxRetryWaitMs?: number;
  /** Used to report learned parameter fixes, so a degradation is never silent. */
  logger?: Logger;
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

/**
 * Newer OpenAI models reject request parameters their predecessors required —
 * `max_tokens` became `max_completion_tokens`, and some models accept only the
 * default `temperature`. Which model wants which is not discoverable up front
 * and changes with every release, so a hardcoded model list would be wrong
 * within months.
 *
 * Instead the provider learns from the rejection: on a 400 that names the
 * offending parameter, it renames or drops it and retries once, then remembers
 * the adjustment for that model. Cost is one wasted request per model per
 * process; the alternative is a list nobody remembers to update.
 */
type ParameterFix =
  | { action: "rename"; to: string }
  | { action: "set"; value: unknown }
  | { action: "drop" };

const PARAMETER_FIXES: Record<string, ParameterFix> = {
  // Renamed on newer models.
  max_tokens: { action: "rename", to: "max_completion_tokens" },
  // Reasoning models refuse to combine reasoning with function tools on
  // /v1/chat/completions and point at /v1/responses instead. Supporting that
  // endpoint is a larger change; turning reasoning off keeps tool calling —
  // which this agent cannot work without — and is logged so the trade-off is
  // visible rather than silent.
  reasoning_effort: { action: "set", value: "none" },
};

/** Anything we have no specific remedy for is simply removed. */
const DEFAULT_FIX: ParameterFix = { action: "drop" };

interface OpenAIErrorBody {
  error?: { message?: string; code?: string; param?: string; type?: string };
}

class UnsupportedParameterError extends Error {
  constructor(readonly param: string) {
    super(`unsupported parameter: ${param}`);
  }
}

export class OpenAICompatibleProvider implements ChatProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly supportsTools: boolean;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly defaultMaxTokens: number;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;
  private readonly maxRetries: number;
  private readonly maxRetryWaitMs: number;

  constructor(options: OpenAICompatibleOptions) {
    this.logger = options.logger;
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.defaultModel = options.model;
    this.supportsTools = options.supportsTools ?? true;
    this.defaultMaxTokens = options.maxTokens ?? 4096;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    // Capped deliberately: the provider may ask for a 60-second wait, and on a
    // live phone call a minute of silence is worse than an honest failure.
    this.maxRetryWaitMs = options.maxRetryWaitMs ?? 20_000;
  }

  /** Per-model parameter fixes learned from 400 responses. */
  private readonly parameterFixes = new Map<string, Map<string, ParameterFix>>();

  private static applyFix(
    body: Record<string, unknown>,
    param: string,
    fix: ParameterFix,
  ): void {
    switch (fix.action) {
      case "rename": {
        if (!(param in body)) return;
        body[fix.to] = body[param];
        delete body[param];
        return;
      }
      case "set":
        // Deliberately unconditional: the parameter is usually absent, and the
        // rejection is about the model's own default rather than what we sent.
        body[param] = fix.value;
        return;
      case "drop":
        delete body[param];
        return;
    }
  }

  private applyLearnedFixes(model: string, body: Record<string, unknown>): void {
    const fixes = this.parameterFixes.get(model);
    if (!fixes) return;
    for (const [param, fix] of fixes) {
      OpenAICompatibleProvider.applyFix(body, param, fix);
    }
  }

  private recordFix(model: string, param: string): ParameterFix {
    const fix = PARAMETER_FIXES[param] ?? DEFAULT_FIX;
    const fixes = this.parameterFixes.get(model) ?? new Map<string, ParameterFix>();
    fixes.set(param, fix);
    this.parameterFixes.set(model, fixes);
    this.logger?.warn(
      { provider: this.name, model, param, fix: fix.action },
      "provider rejected a request parameter; adjusting and retrying",
    );
    return fix;
  }

  /**
   * Posts the request, learning one parameter fix per rejection. Bounded by the
   * number of distinct parameters it has already tried, so a model that keeps
   * objecting can never spin.
   */
  private async postLearning(
    model: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<OpenAIChatResponse> {
    const attempted = new Set<string>();

    for (;;) {
      try {
        return await this.post<OpenAIChatResponse>("/chat/completions", body, signal);
      } catch (err) {
        if (!(err instanceof UnsupportedParameterError)) throw err;
        if (attempted.has(err.param)) {
          throw new ProviderError(
            `${this.name} keeps rejecting "${err.param}" for model "${model}" ` +
              `even after adjusting it`,
            this.name,
          );
        }
        attempted.add(err.param);
        OpenAICompatibleProvider.applyFix(body, err.param, this.recordFix(model, err.param));
      }
    }
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

    this.applyLearnedFixes(model, body);

    // A model can object to several parameters in sequence — gpt-5.6-luna
    // rejects `max_tokens`, then rejects reasoning combined with tools — and
    // the API reports only one per response. Keep learning until it accepts the
    // request or repeats itself.
    const payload = await this.postLearning(model, body, request.signal);

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

  /**
   * Retries throttling and transient server errors.
   *
   * A 429 says how long to wait and is not a failure of the request — treating
   * it as one took down a phone call mid-conversation because the token budget
   * was momentarily exhausted. Parameter rejections (400) are deliberately not
   * retried here; `postLearning` handles those by changing the request.
   */
  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.postOnce<T>(path, body, signal);
      } catch (err) {
        const wait = this.retryDelayFor(err, attempt);
        if (wait === undefined) throw err;
        this.logger?.warn(
          { provider: this.name, attempt: attempt + 1, waitMs: wait },
          "provider throttled or unavailable; retrying",
        );
        await sleep(wait, signal);
      }
    }
  }

  /** Milliseconds to wait before retrying, or undefined to give up. */
  private retryDelayFor(err: unknown, attempt: number): number | undefined {
    if (attempt >= this.maxRetries) return undefined;
    if (!(err instanceof ProviderError)) return undefined;

    const details = err.details as { status?: number; retryAfterMs?: number } | undefined;
    const status = details?.status;
    if (status !== 429 && !(status !== undefined && status >= 500)) return undefined;

    // Honour what the provider asked for; fall back to exponential backoff.
    const requested = details?.retryAfterMs ?? 1_000 * 2 ** attempt;
    return Math.min(requested, this.maxRetryWaitMs);
  }

  private async postOnce<T>(
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
        if (response.status === 400) {
          const parsed = safeParseError(text);
          // The API tells us exactly which parameter it dislikes; use that
          // rather than pattern-matching the human-readable message.
          const rejectsParam =
            parsed?.param !== undefined &&
            (parsed.code === "unsupported_parameter" ||
              /not supported/i.test(parsed.message ?? ""));
          if (rejectsParam && parsed?.param) {
            throw new UnsupportedParameterError(parsed.param);
          }
        }
        throw new ProviderError(
          `${this.name} ${response.status}: ${text.slice(0, 500)}`,
          this.name,
          {
            status: response.status,
            ...(retryAfterMs(response, text) !== undefined
              ? { retryAfterMs: retryAfterMs(response, text) }
              : {}),
          },
        );
      }
      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof ProviderError || err instanceof UnsupportedParameterError) throw err;
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

function safeParseError(text: string): OpenAIErrorBody["error"] | undefined {
  try {
    return (JSON.parse(text) as OpenAIErrorBody).error;
  } catch {
    return undefined;
  }
}

/**
 * How long the provider wants us to wait.
 *
 * `retry-after` is the standard header, but OpenAI's token-per-minute errors
 * carry the delay only in the prose ("Please try again in 26.343s"), so both
 * are read. Missing or nonsensical values fall through to backoff.
 */
function retryAfterMs(response: Response, text: string): number | undefined {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  const match = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(text);
  if (match?.[1]) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      return Math.round(match[2]?.toLowerCase() === "ms" ? value : value * 1000);
    }
  }
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
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
