import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../.env") });

const { loadConfig } = await import("./config.js");
const { createLogger } = await import("@jarvis/shared");
const { buildSpeech } = await import("@jarvis/speech");
const { TelegramClient } = await import("./telegram.js");
const { OrchestratorClient } = await import("./orchestrator.js");
const { UpdateHandler } = await import("./handler.js");
const { createApp } = await import("./app.js");
const { PollingLoop } = await import("./polling.js");

const env = loadConfig();
const logger = createLogger("telegram-adapter");

const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
const orchestrator = new OrchestratorClient(env.ORCHESTRATOR_URL, env.SERVICE_TOKEN, logger);

const speech = buildSpeech({
  stt: env.STT_ENGINE,
  tts: env.TTS_ENGINE,
  logger,
  whisper: {
    model: env.WHISPER_MODEL,
    ...(env.WHISPER_CACHE_DIR ? { cacheDir: env.WHISPER_CACHE_DIR } : {}),
  },
  ...(env.PIPER_BINARY && env.PIPER_MODEL
    ? {
        piper: {
          binaryPath: env.PIPER_BINARY,
          modelPath: env.PIPER_MODEL,
          ...(env.PIPER_VOICES_DIR ? { voicesDir: env.PIPER_VOICES_DIR } : {}),
          modelSampleRate: env.PIPER_SAMPLE_RATE,
        },
      }
    : {}),
  openai: {
    apiKey: env.OPENAI_API_KEY,
    ...(env.OPENAI_STT_MODEL ? { sttModel: env.OPENAI_STT_MODEL } : {}),
    ...(env.OPENAI_STT_PROMPT ? { sttPrompt: env.OPENAI_STT_PROMPT } : {}),
  },
});

const handler = new UpdateHandler(telegram, orchestrator, speech, logger, {
  maxVoiceBytes: env.MAX_VOICE_BYTES,
});

const me = await telegram.getMe();
logger.info({ bot: me.username, id: me.id, mode: env.TELEGRAM_MODE }, "connected to Telegram");

// Without the orchestrator this adapter can do nothing but apologise to the
// user, so say so at startup rather than on their first message.
if (!(await orchestrator.waitUntilReachable())) {
  logger.error(
    { orchestratorUrl: env.ORCHESTRATOR_URL },
    "orchestrator is not reachable — every incoming message will fail until it is up. " +
      "Start it with `pnpm orchestrator:dev` and check that ORCHESTRATOR_URL points at it.",
  );
} else {
  logger.info({ orchestratorUrl: env.ORCHESTRATOR_URL }, "orchestrator reachable");
}

// Fail fast on a missing Piper binary rather than on the first voice reply.
if (env.TTS_ENGINE === "local") {
  const tts = speech.tts as { check?: () => Promise<void> };
  if (tts.check) await tts.check();
}

// Load the Whisper weights now. Measured on this hardware: ~1.3s from the disk
// cache, then ~1s per 5s of audio. Paying that on the first voice note instead
// would make it look like the bot had hung.
if (env.STT_ENGINE === "local") {
  const stt = speech.stt as { warmup?: () => Promise<void> };
  if (stt.warmup) {
    const started = Date.now();
    await stt.warmup();
    logger.info({ model: env.WHISPER_MODEL, ms: Date.now() - started }, "speech model ready");
  }
}

const app = createApp(env, handler, logger);
const server = app.listen(env.TELEGRAM_ADAPTER_PORT, () => {
  logger.info({ port: env.TELEGRAM_ADAPTER_PORT }, "telegram adapter listening");
});

let polling: InstanceType<typeof PollingLoop> | undefined;

if (env.TELEGRAM_MODE === "webhook") {
  await telegram.setWebhook({
    url: `${env.TELEGRAM_WEBHOOK_URL!.replace(/\/+$/, "")}${env.TELEGRAM_WEBHOOK_PATH}`,
    secretToken: env.TELEGRAM_WEBHOOK_SECRET!,
  });
  const info = await telegram.getWebhookInfo();
  logger.info(
    { url: info.url, pending: info.pending_update_count, lastError: info.last_error_message },
    "webhook registered",
  );
} else {
  // getUpdates is refused while a webhook is registered.
  await telegram.deleteWebhook();
  logger.info(
    { reason: "no inbound reachability required" },
    "running in long-polling mode — supported deployment, but only one instance " +
      "may poll a given bot at a time",
  );
  polling = new PollingLoop(telegram, handler, logger);
  polling.start();
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  polling?.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason: String(reason) }, "unhandled rejection");
  process.exit(1);
});
