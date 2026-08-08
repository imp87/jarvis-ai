import type { Logger } from "@jarvis/shared";
import { AnthropicProvider } from "./providers/anthropic.js";
import {
  OpenAICompatibleEmbeddings,
  OpenAICompatibleProvider,
} from "./providers/openai-compatible.js";
import { LlmRouter, type RoutingConfig } from "./router.js";
import type { ChatProvider, EmbeddingProvider } from "./types.js";

export interface ProviderCredentials {
  anthropicApiKey?: string | undefined;
  openaiApiKey?: string | undefined;
  /** Local network address of the Ollama host, e.g. http://192.168.1.50:11434 */
  ollamaBaseUrl?: string | undefined;
}

export interface BuildProvidersOptions extends ProviderCredentials {
  routing: RoutingConfig;
  logger: Logger;
  maxCallsPerMinute?: number;
  /** Model ids used when a profile does not name one. */
  defaults?: {
    anthropicModel?: string;
    openaiModel?: string;
    ollamaModel?: string;
  };
}

/**
 * Builds only the providers whose credentials are actually present. A missing
 * key is not an error here — it becomes one at router validation time if some
 * profile references the absent provider, which is a much clearer message than
 * a 401 during the first real request.
 */
export function buildProviders(options: BuildProvidersOptions): {
  providers: Map<string, ChatProvider>;
  router: LlmRouter;
} {
  const providers = new Map<string, ChatProvider>();

  if (options.anthropicApiKey) {
    providers.set(
      "anthropic",
      new AnthropicProvider({
        apiKey: options.anthropicApiKey,
        ...(options.defaults?.anthropicModel
          ? { model: options.defaults.anthropicModel }
          : {}),
      }),
    );
  }

  if (options.openaiApiKey) {
    providers.set(
      "openai",
      new OpenAICompatibleProvider({
        name: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: options.openaiApiKey,
        logger: options.logger,
        model: options.defaults?.openaiModel ?? "gpt-5.6-luna",
      }),
    );
  }

  if (options.ollamaBaseUrl) {
    providers.set(
      "ollama",
      new OpenAICompatibleProvider({
        name: "ollama",
        baseUrl: `${options.ollamaBaseUrl.replace(/\/+$/, "")}/v1`,
        model: options.defaults?.ollamaModel ?? "qwen2.5:14b",
        // Assume tool support and let the model prove it. If the local model
        // cannot call tools, set supportsTools:false here and give every
        // tool-using profile a fallbackProfile.
        supportsTools: true,
        logger: options.logger,
        // Local hardware is slower than a hosted API; be patient before failing.
        timeoutMs: 300_000,
      }),
    );
  }

  const router = new LlmRouter(providers, options.routing, options.logger, {
    ...(options.maxCallsPerMinute
      ? { maxCallsPerMinute: options.maxCallsPerMinute }
      : {}),
  });

  return { providers, router };
}

export function buildEmbeddingProvider(options: {
  provider: "openai" | "ollama";
  model: string;
  dimensions: number;
  openaiApiKey?: string | undefined;
  ollamaBaseUrl?: string | undefined;
}): EmbeddingProvider {
  if (options.provider === "openai") {
    if (!options.openaiApiKey) {
      throw new Error("EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY");
    }
    return new OpenAICompatibleEmbeddings({
      name: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: options.openaiApiKey,
      model: options.model,
      dimensions: options.dimensions,
    });
  }

  if (!options.ollamaBaseUrl) {
    throw new Error("EMBEDDING_PROVIDER=ollama requires OLLAMA_BASE_URL");
  }
  return new OpenAICompatibleEmbeddings({
    name: "ollama",
    baseUrl: `${options.ollamaBaseUrl.replace(/\/+$/, "")}/v1`,
    model: options.model,
    dimensions: options.dimensions,
  });
}
