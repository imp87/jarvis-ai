import { z } from "zod";

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  DATABASE_URL: z.string().url(),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(1536),

  // 32 bytes hex
  MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "MASTER_KEY must be 64 hex characters"),
  SERVICE_TOKEN: z.string().min(32, "SERVICE_TOKEN must be at least 32 characters"),

  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().url().optional(),

  EMBEDDING_PROVIDER: z.enum(["openai", "ollama"]).default("openai"),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),

  QUIET_HOURS_START: timeOfDay.default("22:00"),
  QUIET_HOURS_END: timeOfDay.default("07:00"),
  QUIET_HOURS_TIMEZONE: z.string().default("Europe/Berlin"),
  MAX_CALLS_PER_HOUR: z.coerce.number().int().nonnegative().default(2),
  MAX_CALLS_PER_DAY: z.coerce.number().int().nonnegative().default(8),

  MAX_LLM_CALLS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  MAX_AGENT_STEPS: z.coerce.number().int().positive().max(50).default(12),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/**
 * Parse and validate the environment once, at startup. A missing secret should
 * crash the process immediately, not surface as a 500 an hour later.
 */
export function loadEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  // Treat an empty value as absent. Docker Compose substitutes `${FOO:-}` to an
  // empty string for anything not in .env, which would otherwise fail every
  // optional `.url()` field and defeat every `.default()`.
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== "") cleaned[key] = value;
  }

  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
