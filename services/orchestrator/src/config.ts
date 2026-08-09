import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { baseEnvSchema, loadEnv } from "@jarvis/shared";
import { routingConfigSchema, type RoutingConfig } from "@jarvis/llm";

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(here, "..");

export const envSchema = baseEnvSchema.extend({
  ORCHESTRATOR_PORT: z.coerce.number().int().positive().default(8080),
  /** Where the routing profiles live. Override to hot-swap routing per environment. */
  LLM_ROUTING_CONFIG: z.string().optional(),
  /** Default reply channel for agent-initiated notifications. */
  DEFAULT_NOTIFY_CHANNEL: z.string().default("telegram"),
  /** Number the agent calls when an email crosses the importance threshold. */
  OWNER_PHONE_NUMBER: z.string().optional(),
  /** Voice pipeline endpoint. Absent until component 1 exists. */
  VOICE_PIPELINE_URL: z.string().url().optional(),
  /** Public origin of the admin app, used as the deployed OAuth callback default. */
  MCP_OAUTH_CALLBACK_BASE_URL: z.string().url().default("https://jarvis.steven-dautrich.de"),

  /**
   * Backend for the embedded `web` MCP server. DuckDuckGo's HTML endpoint is
   * the default because it needs no account, so web search works on a fresh
   * install; it is a scrape, so switch providers if it ever stops returning
   * results.
   */
  WEB_SEARCH_PROVIDER: z.enum(["duckduckgo", "brave", "searxng"]).default("duckduckgo"),
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  /** Base URL of a self-hosted SearXNG instance, e.g. http://searxng:8080. */
  SEARXNG_URL: z.string().url().optional(),
  WEB_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** Ceiling on a downloaded body before text extraction. */
  WEB_FETCH_MAX_BYTES: z.coerce.number().int().positive().default(2_000_000),
})
  .refine((v) => v.WEB_SEARCH_PROVIDER !== "brave" || Boolean(v.BRAVE_SEARCH_API_KEY), {
    message: "WEB_SEARCH_PROVIDER=brave requires BRAVE_SEARCH_API_KEY",
    path: ["BRAVE_SEARCH_API_KEY"],
  })
  .refine((v) => v.WEB_SEARCH_PROVIDER !== "searxng" || Boolean(v.SEARXNG_URL), {
    message: "WEB_SEARCH_PROVIDER=searxng requires SEARXNG_URL",
    path: ["SEARXNG_URL"],
  });

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env;
  routing: RoutingConfig;
}

export function loadConfig(): AppConfig {
  const env = loadEnv(envSchema);
  const routingPath =
    env.LLM_ROUTING_CONFIG ?? path.join(serviceRoot, "config", "llm-routing.json");

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(routingPath, "utf8"));
  } catch (err) {
    throw new Error(`could not read LLM routing config at ${routingPath}: ${(err as Error).message}`);
  }

  // Strip documentation keys before validating.
  if (raw && typeof raw === "object") {
    delete (raw as Record<string, unknown>)["$comment"];
  }

  const parsed = routingConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid LLM routing config at ${routingPath}:\n${issues}`);
  }

  return { env, routing: parsed.data };
}
