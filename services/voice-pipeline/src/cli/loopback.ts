#!/usr/bin/env node
/**
 * Runs a whole conversation without a phone line.
 *
 * Caller speech is produced with TTS (so no recordings are needed), pushed
 * through the real session engine, and everything the agent says is written to
 * a WAV file you can listen to. This is how the agent gets verified on a
 * machine that cannot reach the FritzBox — and afterwards it stays useful:
 * when a real call misbehaves, running the same words through here says
 * immediately whether the fault is in the agent or in the telephony.
 *
 *   pnpm --filter @jarvis/voice-pipeline run loopback "Hallo, wer bist du?"
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../../.env") });

const { createLogger, normalisePhoneNumber } = await import("@jarvis/shared");
const { buildSpeech, convertAudio } = await import("@jarvis/speech");
const { loadConfig } = await import("../config.js");
const { OrchestratorClient } = await import("../orchestrator.js");
const { CallSession } = await import("../session.js");
const { LoopbackTransport } = await import("../transports/loopback.js");

const utterances = process.argv.slice(2);
if (utterances.length === 0) {
  utterances.push("Hallo, wer bist du?", "Was steht in meinem Arbeitsverzeichnis?");
}

const env = loadConfig();
const logger = createLogger("loopback");
const speech = buildSpeech({
  stt: env.STT_ENGINE,
  tts: env.TTS_ENGINE,
  logger,
  whisper: { model: env.WHISPER_MODEL },
  ...(env.PIPER_BINARY && env.PIPER_MODEL
    ? {
        piper: {
          binaryPath: env.PIPER_BINARY,
          modelPath: env.PIPER_MODEL,
          modelSampleRate: env.PIPER_SAMPLE_RATE,
        },
      }
    : {}),
  openai: { apiKey: env.OPENAI_API_KEY },
});

const number = normalisePhoneNumber(env.OWNER_PHONE_NUMBER ?? "015561049738");
const orchestrator = new OrchestratorClient(env.ORCHESTRATOR_URL, env.SERVICE_TOKEN, logger);

const caller = await orchestrator.authoriseCaller(number);
if (!caller) {
  console.error(`${number} is not registered as a voice_call identity — the gate would reject it.`);
  process.exit(1);
}
console.log(`caller authorised: ${caller.displayName}\n`);

const transport = new LoopbackTransport({
  direction: "inbound",
  remoteNumber: number,
  // Faster than real time, but still frame-by-frame so endpointing behaves
  // as it would on a line.
  speed: 8,
});

const session = new CallSession(transport, speech, orchestrator, number, logger, {
  greeting: "Hallo Steve, hier ist Jarvis. Was kann ich für dich tun?",
  language: "de",
  idleHangupMs: 3_000,
});

const finished = session.run();

/** Half-duplex: talking while the agent talks is dropped, so wait it out. */
async function waitUntilAgentFinishes(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Give the agent a moment to start, otherwise `busy` reads false too early.
  await new Promise((r) => setTimeout(r, 250));
  while (session.busy && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

await waitUntilAgentFinishes();

for (const text of utterances) {
  const clip = await speech.tts.synthesize(text, { format: "raw_pcm16", sampleRate: 8000, language: "de" });
  console.log(`caller: ${text}`);
  await transport.play(clip.data);
  await waitUntilAgentFinishes();
}
await transport.hangup();

const result = await finished;
console.log(`\n--- transcript (${result.turns} turns, ended: ${result.endedBecause}) ---`);
for (const line of result.transcript) {
  console.log(`${line.role === "user" ? "heard " : "agent "}: ${line.text}`);
}

const wav = await convertAudio(
  { data: transport.recordedOutput(), encoding: "raw_pcm16", sampleRate: 8000, channels: 1 },
  { encoding: "wav_pcm16", sampleRate: 8000 },
);
const out = path.resolve(here, "../../../../.local/loopback-call.wav");
writeFileSync(out, wav.data);
console.log(`\nagent audio written to ${out} (${wav.data.length} bytes)`);
