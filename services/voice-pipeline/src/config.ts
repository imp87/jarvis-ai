import { z } from "zod";
import { loadEnv } from "@jarvis/shared";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    VOICE_PIPELINE_PORT: z.coerce.number().int().positive().default(8082),

    ORCHESTRATOR_URL: z.string().url().default("http://127.0.0.1:8080"),
    SERVICE_TOKEN: z.string().min(32),

    // --- SIP / FritzBox -----------------------------------------------------
    // The FritzBox acts as the registrar; the pipeline registers as an IP
    // telephone (Telefonie -> Telefoniegeraete -> LAN/WLAN-Telefon). One
    // registration serves both directions: it can place and receive calls.
    SIP_ADRESS: z.string().optional(),
    SIP_USER: z.string().optional(),
    SIP_PASSWORD: z.string().optional(),
    /** Number the agent dials from, if the extension serves several. */
    SIP_CALLER_ID: z.string().optional(),

    OWNER_PHONE_NUMBER: z.string().optional(),
    /** Spoken when the agent answers, before it knows why you called. */
    VOICE_GREETING: z.string().default("Hallo, hier ist Jarvis. Was kann ich für dich tun?"),
    /** Hang up after this much silence. */
    VOICE_IDLE_HANGUP_MS: z.coerce.number().int().positive().default(30_000),

    // --- Speech -------------------------------------------------------------
    STT_ENGINE: z.enum(["local", "openai"]).default("local"),
    TTS_ENGINE: z.enum(["local", "openai"]).default("local"),
    WHISPER_MODEL: z.string().default("Xenova/whisper-base"),
    /** Persistent model cache. Without it every restart re-downloads ~280 MB. */
    WHISPER_CACHE_DIR: z.string().optional(),
    PIPER_BINARY: z.string().optional(),
    PIPER_MODEL: z.string().optional(),
    PIPER_SAMPLE_RATE: z.coerce.number().int().positive().default(22_050),
    OPENAI_API_KEY: z.string().optional(),
    /** Full model is a useful accuracy upgrade for narrowband phone audio. */
    OPENAI_STT_MODEL: z.string().optional(),
    /** German context and product names guide transcription without changing audio. */
    OPENAI_STT_PROMPT: z.string().max(2_000).optional(),
  })
  .refine((v) => v.TTS_ENGINE !== "local" || (Boolean(v.PIPER_BINARY) && Boolean(v.PIPER_MODEL)), {
    message: "local TTS needs PIPER_BINARY and PIPER_MODEL, or set TTS_ENGINE=openai",
    path: ["PIPER_BINARY"],
  })
  .refine(
    (v) => (v.STT_ENGINE !== "openai" && v.TTS_ENGINE !== "openai") || Boolean(v.OPENAI_API_KEY),
    { message: "OPENAI_API_KEY is required when an engine is set to openai", path: ["OPENAI_API_KEY"] },
  );

export type Env = z.infer<typeof envSchema>;

export function loadConfig(): Env {
  return loadEnv(envSchema);
}
