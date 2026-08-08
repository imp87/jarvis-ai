import { z } from "zod";
import { loadEnv } from "@jarvis/shared";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    TELEGRAM_ADAPTER_PORT: z.coerce.number().int().positive().default(8081),

    TELEGRAM_BOT_TOKEN: z.string().min(20, "looks too short to be a bot token"),

    /**
     * Both modes are supported deployments; neither is a dev-only hack.
     *
     * "polling" needs no inbound reachability at all, which is the only thing
     * that works behind DS-Lite/CGNAT unless the ISP forwards one of the four
     * ports Telegram accepts (80, 88, 443, 8443). Verified against the live
     * API: any other port is rejected outright with
     *   "bad webhook: Webhook can be set up only on ports 80, 88, 443 or 8443"
     *
     * "webhook" scales better and avoids holding an open request, but requires
     * a publicly reachable HTTPS endpoint on one of those ports.
     */
    TELEGRAM_MODE: z.enum(["webhook", "polling"]).default("polling"),

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
  .refine((v) => v.TELEGRAM_MODE !== "webhook" || v.TELEGRAM_WEBHOOK_URL?.startsWith("https://"), {
    message: "Telegram only delivers webhooks over HTTPS",
    path: ["TELEGRAM_WEBHOOK_URL"],
  })
  // Fail here rather than letting Telegram reject setWebhook at startup with a
  // message nobody reads. Port is implicit 443 when the URL omits it.
  .refine(
    (v) => {
      if (v.TELEGRAM_MODE !== "webhook" || !v.TELEGRAM_WEBHOOK_URL) return true;
      const port = new URL(v.TELEGRAM_WEBHOOK_URL).port;
      return port === "" || ["80", "88", "443", "8443"].includes(port);
    },
    {
      message:
        "Telegram only delivers webhooks to ports 80, 88, 443 or 8443. " +
        "If your ISP forwards a different range (common with DS-Lite), use TELEGRAM_MODE=polling.",
      path: ["TELEGRAM_WEBHOOK_URL"],
    },
  )
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
