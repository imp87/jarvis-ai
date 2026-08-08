import { z } from "zod";
import { loadEnv } from "@jarvis/shared";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    TELEGRAM_ADAPTER_PORT: z.coerce.number().int().positive().default(8081),

    TELEGRAM_BOT_TOKEN: z.string().min(20, "looks too short to be a bot token"),

    /**
     * "webhook" is the production path. "polling" exists so the adapter can be
     * verified before DynDNS, port forwarding and TLS are in place; it is
     * refused in production so nobody ships it by accident.
     */
    TELEGRAM_MODE: z.enum(["webhook", "polling"]).default("webhook"),

    /** Public HTTPS URL Telegram delivers to. Required in webhook mode. */
    TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
    /**
     * Echoed by Telegram in X-Telegram-Bot-Api-Secret-Token on every delivery.
     * This is the primary proof a request really came from Telegram.
     */
    TELEGRAM_WEBHOOK_SECRET: z
      .string()
      .min(32, "use at least 32 characters")
      .regex(/^[A-Za-z0-9_-]+$/, "Telegram only accepts A-Z a-z 0-9 _ and -")
      .optional(),
    /** Path segment of the webhook route. Keep it long and random. */
    TELEGRAM_WEBHOOK_PATH: z.string().startsWith("/").default("/telegram/webhook"),
    /** Set false only if a proxy already restricts source IPs. */
    TELEGRAM_IP_ALLOWLIST: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),

    ORCHESTRATOR_URL: z.string().url().default("http://127.0.0.1:8080"),
    SERVICE_TOKEN: z.string().min(32),

    /** Voice notes larger than this are refused before download. */
    MAX_VOICE_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),

    // --- Speech ------------------------------------------------------------
    // Local by default: voice notes are sensitive and should not leave the
    // machine unless that is an explicit decision.
    STT_ENGINE: z.enum(["local", "openai"]).default("local"),
    TTS_ENGINE: z.enum(["local", "openai"]).default("local"),
    WHISPER_MODEL: z.string().default("Xenova/whisper-base"),
    WHISPER_CACHE_DIR: z.string().optional(),
    PIPER_BINARY: z.string().optional(),
    PIPER_MODEL: z.string().optional(),
    PIPER_VOICES_DIR: z.string().optional(),
    PIPER_SAMPLE_RATE: z.coerce.number().int().positive().default(22_050),
    OPENAI_API_KEY: z.string().optional(),
  })
  .refine((v) => v.TELEGRAM_MODE !== "webhook" || Boolean(v.TELEGRAM_WEBHOOK_URL), {
    message: "TELEGRAM_WEBHOOK_URL is required when TELEGRAM_MODE=webhook",
    path: ["TELEGRAM_WEBHOOK_URL"],
  })
  .refine((v) => v.TELEGRAM_MODE !== "webhook" || Boolean(v.TELEGRAM_WEBHOOK_SECRET), {
    message: "TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_MODE=webhook",
    path: ["TELEGRAM_WEBHOOK_SECRET"],
  })
  .refine((v) => !(v.NODE_ENV === "production" && v.TELEGRAM_MODE === "polling"), {
    message: "polling is a development-only mode and is refused in production",
    path: ["TELEGRAM_MODE"],
  })
  .refine((v) => v.TELEGRAM_MODE !== "webhook" || v.TELEGRAM_WEBHOOK_URL?.startsWith("https://"), {
    message: "Telegram only delivers webhooks over HTTPS",
    path: ["TELEGRAM_WEBHOOK_URL"],
  })
  .refine((v) => v.TTS_ENGINE !== "local" || (Boolean(v.PIPER_BINARY) && Boolean(v.PIPER_MODEL)), {
    message:
      "local TTS needs PIPER_BINARY and PIPER_MODEL (see docs/telegram-setup.md), " +
      "or set TTS_ENGINE=openai",
    path: ["PIPER_BINARY"],
  })
  .refine((v) => (v.STT_ENGINE !== "openai" && v.TTS_ENGINE !== "openai") || Boolean(v.OPENAI_API_KEY), {
    message: "OPENAI_API_KEY is required when an engine is set to openai",
    path: ["OPENAI_API_KEY"],
  });

export type Env = z.infer<typeof envSchema>;

export function loadConfig(): Env {
  return loadEnv(envSchema);
}
