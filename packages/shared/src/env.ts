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
  // The orchestrator's own alarms draw on a separate allowance, so a day of
  // reminders cannot exhaust the channel that reports a failure. Small on
  // purpose: these pass quiet hours, and an alarm without a ceiling is itself a
  // way to be dialled all night. 0 means unlimited, as everywhere else here.
  SYSTEM_ALERT_CALLS_PER_HOUR: z.coerce.number().int().nonnegative().default(1),
  SYSTEM_ALERT_CALLS_PER_DAY: z.coerce.number().int().nonnegative().default(3),

  MAX_LLM_CALLS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  MAX_AGENT_STEPS: z.coerce.number().int().positive().max(50).default(12),

  /**
   * Ceiling on a single tool result, in characters (~4 per token).
   *
   * A schema dump or a directory listing can run to six figures. The model
   * cannot act on that much text anyway, and — because results are persisted as
   * conversation messages — an unbounded one is re-sent on every subsequent
   * turn, for the life of the conversation. One 107 KB `list_tables` result
   * pushed real requests to ~84k input tokens and exhausted the provider's
   * per-minute token budget after two turns.
   */
  MAX_TOOL_RESULT_CHARS: z.coerce.number().int().positive().default(8_000),

  /**
   * Ceiling on the replayed conversation history, in characters.
   *
   * Trimming by message count alone bounds nothing: forty messages can be forty
   * kilobytes or forty megabytes.
   */
  MAX_HISTORY_CHARS: z.coerce.number().int().positive().default(48_000),

  /**
   * Where to push proactive messages. Absent means the agent has no way to
   * speak first on that channel, and the tool for it is withheld rather than
   * offered and silently failing.
   */
  TELEGRAM_ADAPTER_URL: z.string().url().optional(),
  /** How often the scheduler looks for due tasks. */
  TASK_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(20_000),
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
