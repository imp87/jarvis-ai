import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AudioClip, SpeechServices, SynthesisOptions } from "@jarvis/speech";
import type { Logger } from "@jarvis/shared";
import { CallSession } from "../src/session.js";
import { LoopbackTransport } from "../src/transports/loopback.js";
import type { OrchestratorClient, ReplyResult } from "../src/orchestrator.js";
import { FRAME_BYTES } from "../src/transport.js";

/**
 * The agent hanging up on itself, exercised through the real session engine and
 * the loopback transport. What matters here is the ordering: `end_call` must not
 * cut the agent off mid-goodbye, which is invisible in any test that only checks
 * that the call ended.
 */

const SAMPLES_PER_MS = 8; // 8 kHz, one 16-bit sample each

/** Loud enough for the endpointer to call it speech. */
function tone(ms: number): Buffer {
  const samples = ms * SAMPLES_PER_MS;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin(i / 4) * 0.3 * 32_767), i * 2);
  }
  return buf;
}

/** Bytes of raw 8 kHz PCM a clip of this length occupies. */
function bytesFor(ms: number): number {
  return ms * SAMPLES_PER_MS * 2;
}

const GREETING_MS = 200;
const FAREWELL_MS = 600;

function stubSpeech(heard: string): SpeechServices {
  return {
    stt: {
      name: "stub",
      async transcribe() {
        return { text: heard, provider: "stub" };
      },
    },
    tts: {
      name: "stub",
      async synthesize(text: string, _options: SynthesisOptions): Promise<AudioClip> {
        // The farewell is deliberately the longest clip: if the hangup raced the
        // playback, the recording would come up short by a measurable amount.
        const ms = text.startsWith("Hallo") ? GREETING_MS : FAREWELL_MS;
        return { data: tone(ms), encoding: "raw_pcm16", sampleRate: 8000, channels: 1 };
      },
    },
  };
}

function stubOrchestrator(reply: ReplyResult): OrchestratorClient {
  return {
    async send() {
      return reply;
    },
  } as unknown as OrchestratorClient;
}

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silentLogger;
  },
} as unknown as Logger;

async function runCall(reply: ReplyResult) {
  const transport = new LoopbackTransport({
    direction: "inbound",
    remoteNumber: "+4915561049738",
    // As fast as the event loop allows; endpointing still sees every frame.
    speed: 0,
  });

  const session = new CallSession(
    transport,
    stubSpeech("Danke, das war alles."),
    stubOrchestrator(reply),
    "+4915561049738",
    silentLogger,
    {
      greeting: "Hallo, hier ist Jarvis.",
      language: "de",
      idleHangupMs: 60_000,
    },
  );

  const finished = session.run();

  // Wait out the greeting before speaking: half-duplex drops anything said
  // while the agent is talking.
  while (session.busy) await delay(5);

  await transport.play(tone(400), 800);
  while (session.busy) await delay(5);

  // A caller hangup would end the call too — hold the line open so anything the
  // assertions see was decided by the agent.
  const timeout = setTimeout(() => void transport.hangup(), 5_000);
  const result = await finished;
  clearTimeout(timeout);

  return { result, transport };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("CallSession end_call", () => {
  it("hangs up when the agent asks to, and reports who ended it", async () => {
    const { result } = await runCall({
      conversationId: "c1",
      reply: "Alles klar, bis später!",
      endCall: { reason: "caller said goodbye" },
    });

    assert.equal(result.endedBecause, "agent");
    assert.equal(result.turns, 1);
    assert.deepEqual(
      result.transcript.map((t) => t.role),
      ["user", "assistant"],
    );
  });

  it("plays the whole goodbye before closing the line", async () => {
    const { transport } = await runCall({
      conversationId: "c1",
      reply: "Alles klar, bis später!",
      endCall: { reason: "caller said goodbye" },
    });

    // Frames are padded to a whole frame each way, so compare against the
    // frame-aligned total rather than the raw clip lengths.
    const expected =
      Math.ceil(bytesFor(GREETING_MS) / FRAME_BYTES) * FRAME_BYTES +
      Math.ceil(bytesFor(FAREWELL_MS) / FRAME_BYTES) * FRAME_BYTES;

    assert.equal(
      transport.recordedOutput().length,
      expected,
      "the farewell was truncated — the hangup ran before playback finished",
    );
  });

  it("stays on the line when the agent does not ask to hang up", async () => {
    const transport = new LoopbackTransport({ direction: "inbound", speed: 0 });
    const session = new CallSession(
      transport,
      stubSpeech("Und noch etwas."),
      stubOrchestrator({ conversationId: "c1", reply: "Klar, was denn?", endCall: null }),
      "+4915561049738",
      silentLogger,
      { greeting: "Hallo, hier ist Jarvis.", language: "de", idleHangupMs: 60_000 },
    );

    const finished = session.run();
    while (session.busy) await delay(5);
    await transport.play(tone(400), 800);
    while (session.busy) await delay(5);

    // Still up: only the caller hanging up ends it.
    await transport.hangup();
    const result = await finished;
    assert.equal(result.endedBecause, "hangup");
  });
});
