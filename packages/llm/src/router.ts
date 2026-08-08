import { z } from "zod";
import { PolicyError, ProviderError, RateLimiter, type Logger } from "@jarvis/shared";
import type { ChatProvider, ChatRequest, ChatResponse, Effort } from "./types.js";

/**
 * Routing lives in config, not in code (component 10). A profile is a named
 * intent — "classify", "chat", "agent" — that call sites ask for; the mapping
 * from intent to provider and model is data you can change without a deploy.
 */
export const profileSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  /**
   * Profile to fall back to when this one cannot serve the request — currently
   * only when tools are required and the provider cannot call them. A local
   * model that can't do function calling silently answering in prose is the
   * most annoying possible failure, so make the fallback explicit.
   */
  fallbackProfile: z.string().optional(),
});
export type ProfileConfig = z.infer<typeof profileSchema>;

export const routingConfigSchema = z.object({
  /** Profile used when a call site doesn't name one. */
  defaultProfile: z.string(),
  profiles: z.record(profileSchema),
});
export type RoutingConfig = z.infer<typeof routingConfigSchema>;

export interface ResolvedRoute {
  profile: string;
  provider: ChatProvider;
  model: string;
  effort: Effort | undefined;
}

export class LlmRouter {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly providers: Map<string, ChatProvider>,
    private readonly config: RoutingConfig,
    private readonly logger: Logger,
    options: { maxCallsPerMinute?: number } = {},
  ) {
    this.limiter = new RateLimiter(options.maxCallsPerMinute ?? 60, 60_000);
    this.validate();
  }

  /** Fail at startup, not on the first request at 2am. */
  private validate(): void {
    const names = Object.keys(this.config.profiles);
    if (!this.config.profiles[this.config.defaultProfile]) {
      throw new Error(
        `defaultProfile "${this.config.defaultProfile}" is not defined (have: ${names.join(", ")})`,
      );
    }
    for (const [name, profile] of Object.entries(this.config.profiles)) {
      if (!this.providers.has(profile.provider)) {
        throw new Error(
          `profile "${name}" references provider "${profile.provider}", which is not configured. ` +
            `Configured providers: ${[...this.providers.keys()].join(", ") || "(none)"}`,
        );
      }
      if (profile.fallbackProfile && !this.config.profiles[profile.fallbackProfile]) {
        throw new Error(
          `profile "${name}" falls back to "${profile.fallbackProfile}", which is not defined`,
        );
      }
    }
  }

  listProfiles(): Array<{ name: string; provider: string; model: string }> {
    return Object.entries(this.config.profiles).map(([name, profile]) => ({
      name,
      provider: profile.provider,
      model: profile.model ?? this.providers.get(profile.provider)!.defaultModel,
    }));
  }

  resolve(profileName: string | undefined, requiresTools: boolean): ResolvedRoute {
    const name = profileName ?? this.config.defaultProfile;
    const profile = this.config.profiles[name];
    if (!profile) {
      throw new ProviderError(`unknown LLM profile "${name}"`, "router");
    }
    const provider = this.providers.get(profile.provider)!;

    if (requiresTools && !provider.supportsTools) {
      if (!profile.fallbackProfile) {
        throw new ProviderError(
          `profile "${name}" uses provider "${provider.name}", which cannot call tools, ` +
            `and defines no fallbackProfile`,
          "router",
        );
      }
      this.logger.warn(
        { profile: name, fallback: profile.fallbackProfile },
        "profile cannot call tools; using fallback",
      );
      return this.resolve(profile.fallbackProfile, requiresTools);
    }

    return {
      profile: name,
      provider,
      model: profile.model ?? provider.defaultModel,
      effort: profile.effort,
    };
  }

  async chat(
    profileName: string | undefined,
    request: ChatRequest,
  ): Promise<ChatResponse & { profile: string }> {
    const route = this.resolve(profileName, Boolean(request.tools?.length));
    const profile = this.config.profiles[route.profile]!;

    // Every path that spends money gets a ceiling. A runaway agent loop should
    // hit this and stop, not discover the limit on next month's invoice.
    if (!this.limiter.tryAcquire()) {
      throw new PolicyError("LLM call rate limit exceeded", { profile: route.profile });
    }

    // Request wins over profile; profile wins over provider default.
    const merged: ChatRequest = { ...request, model: request.model ?? route.model };
    const effort = request.effort ?? route.effort;
    if (effort !== undefined) merged.effort = effort;
    const maxTokens = request.maxTokens ?? profile.maxTokens;
    if (maxTokens !== undefined) merged.maxTokens = maxTokens;
    const temperature = request.temperature ?? profile.temperature;
    if (temperature !== undefined) merged.temperature = temperature;

    const started = Date.now();
    const response = await route.provider.chat(merged);

    this.logger.debug(
      {
        profile: route.profile,
        provider: response.provider,
        model: response.model,
        stopReason: response.stopReason,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        durationMs: Date.now() - started,
      },
      "llm call",
    );

    return { ...response, profile: route.profile };
  }
}
