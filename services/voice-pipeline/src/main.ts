import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../.env") });

const { loadConfig } = await import("./config.js");
const { createLogger } = await import("@jarvis/shared");
const { buildSpeech } = await import("@jarvis/speech");
const { OrchestratorClient } = await import("./orchestrator.js");
const { WebSocketMediaServer } = await import("./transports/websocket-media.js");
const { CallOriginator } = await import("./originate.js");
const { CallSession } = await import("./session.js");
const { RealtimeCallSession } = await import("./realtime-session.js");
const { createApp } = await import("./app.js");

const env = loadConfig();
const logger = createLogger("voice-pipeline");

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
          modelSampleRate: env.PIPER_SAMPLE_RATE,
        },
      }
    : {}),
  openai: {
    apiKey: env.OPENAI_API_KEY,
    ...(env.OPENAI_STT_MODEL ? { sttModel: env.OPENAI_STT_MODEL } : {}),
    ...(env.OPENAI_STT_PROMPT ? { sttPrompt: env.OPENAI_STT_PROMPT } : {}),
    ttsSpeed: env.OPENAI_TTS_SPEED,
  },
});

const orchestrator = new OrchestratorClient(env.ORCHESTRATOR_URL, env.SERVICE_TOKEN, logger);
/** Why the agent is calling, set when the call is queued and used as its opener. */
const pendingContext = new Map<string, string>();

const handleCall = async (
  transport: import("./transport.js").CallTransport,
  pending: import("./transports/audiosocket.js").PendingCall,
): Promise<void> => {
  const context = pendingContext.get(pending.callId);
  pendingContext.delete(pending.callId);

  const greeting =
    pending.direction === "outbound" && context
      ? `Hallo, hier ist Jarvis. ${context}`
      : env.VOICE_GREETING;

  logger.info({ callId: pending.callId, direction: pending.direction, mode: env.VOICE_MODE }, "call connected");
  const result =
    env.VOICE_MODE === "realtime"
      ? await new RealtimeCallSession(transport, orchestrator, pending.channelUserId, logger, {
          apiKey: env.OPENAI_API_KEY!,
          model: env.OPENAI_REALTIME_MODEL,
          voice: env.OPENAI_REALTIME_VOICE,
          greeting,
          idleHangupMs: env.VOICE_IDLE_HANGUP_MS,
        }).run()
      : await new CallSession(transport, speech, orchestrator, pending.channelUserId, logger, {
          greeting,
          language: "de",
          idleHangupMs: env.VOICE_IDLE_HANGUP_MS,
        }).run();
  logger.info(
    { callId: pending.callId, turns: result.turns, endedBecause: result.endedBecause },
    "call finished",
  );
};

const originator = new CallOriginator(
  {
    spoolDir: process.env["ASTERISK_SPOOL_DIR"] ?? "/var/spool/asterisk/outgoing",
    stagingDir: process.env["ASTERISK_STAGING_DIR"] ?? "/var/spool/asterisk/staging",
    ...(env.SIP_CALLER_ID ? { callerId: env.SIP_CALLER_ID } : {}),
  },
  logger,
);

// Load the speech models before the first call rather than during it.
if (env.STT_ENGINE === "local") {
  const stt = speech.stt as { warmup?: () => Promise<void> };
  if (stt.warmup) {
    const started = Date.now();
    await stt.warmup();
    logger.info({ ms: Date.now() - started }, "speech model ready");
  }
}
if (env.TTS_ENGINE === "local") {
  const tts = speech.tts as { check?: () => Promise<void> };
  if (tts.check) await tts.check();
}

const media = new WebSocketMediaServer(env.SERVICE_TOKEN, logger, handleCall);
const app = createApp({ env, logger, orchestrator, media, originator, pendingContext });
const server = app.listen(env.VOICE_PIPELINE_PORT, () => {
  logger.info(
    { http: env.VOICE_PIPELINE_PORT, media: "websocket/slin16" },
    "voice pipeline listening",
  );
});
media.attach(server);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  await media.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason: String(reason) }, "unhandled rejection");
  process.exit(1);
});
