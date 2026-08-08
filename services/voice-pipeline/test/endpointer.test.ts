import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Endpointer } from "../src/audio/endpointer.js";

const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (8000 * FRAME_MS) / 1000; // 160 samples at 8 kHz

function frame(amplitude: number): Buffer {
  const buf = Buffer.alloc(SAMPLES_PER_FRAME * 2);
  for (let i = 0; i < SAMPLES_PER_FRAME; i += 1) {
    // A sine keeps RMS predictable: rms = amplitude / sqrt(2).
    const value = Math.sin((i / SAMPLES_PER_FRAME) * Math.PI * 8) * amplitude * 32_767;
    buf.writeInt16LE(Math.round(value), i * 2);
  }
  return buf;
}

const SPEECH = frame(0.3);
const SILENCE = frame(0.001);

function feed(ep: Endpointer, f: Buffer, count: number) {
  const events = [];
  for (let i = 0; i < count; i += 1) {
    const e = ep.push(f);
    if (e.type !== "none") events.push(e);
  }
  return events;
}

describe("Endpointer.rms", () => {
  it("separates speech from line noise", () => {
    assert.ok(Endpointer.rms(SPEECH) > 0.15, String(Endpointer.rms(SPEECH)));
    assert.ok(Endpointer.rms(SILENCE) < 0.005, String(Endpointer.rms(SILENCE)));
    assert.equal(Endpointer.rms(Buffer.alloc(0)), 0);
  });
});

describe("Endpointer", () => {
  it("opens an utterance only after sustained speech", () => {
    const ep = new Endpointer({ minSpeechMs: 120, frameMs: FRAME_MS });
    // A single loud frame is a click, not speech.
    assert.deepEqual(feed(ep, SPEECH, 1), []);
    assert.equal(ep.speaking, false);
    const events = feed(ep, SPEECH, 5);
    assert.equal(events[0]?.type, "speech_start");
    assert.equal(ep.speaking, true);
  });

  it("closes the utterance after the configured silence", () => {
    const ep = new Endpointer({ silenceMs: 700, minSpeechMs: 120, frameMs: FRAME_MS });
    feed(ep, SPEECH, 50); // 1000 ms of speech
    // Silence shorter than the threshold must not end the turn — people pause
    // mid-sentence and cutting them off there is the worst failure mode.
    assert.deepEqual(feed(ep, SILENCE, 30), []); // 600 ms
    const events = feed(ep, SILENCE, 10); // crosses 700 ms
    assert.equal(events[0]?.type, "speech_end");
    assert.equal(events[0]?.type === "speech_end" && events[0].reason, "silence");
  });

  it("survives a pause in the middle of a sentence", () => {
    const ep = new Endpointer({ silenceMs: 700, minSpeechMs: 120, frameMs: FRAME_MS });
    feed(ep, SPEECH, 25);
    feed(ep, SILENCE, 20); // 400 ms — thinking, not finished
    assert.deepEqual(feed(ep, SPEECH, 25), []); // still the same utterance
    assert.equal(ep.speaking, true);
  });

  it("excludes trailing silence from the reported duration", () => {
    const ep = new Endpointer({ silenceMs: 700, minSpeechMs: 120, frameMs: FRAME_MS });
    feed(ep, SPEECH, 50); // 1000 ms
    const events = feed(ep, SILENCE, 35); // 700 ms closes it
    const end = events[0];
    assert.ok(end?.type === "speech_end");
    // Duration should reflect the speech, not speech + silence.
    assert.ok(end.durationMs <= 1100, `reported ${end.durationMs}ms`);
    assert.ok(end.durationMs >= 900, `reported ${end.durationMs}ms`);
  });

  it("caps a runaway utterance so a noisy line cannot buffer forever", () => {
    const ep = new Endpointer({ maxUtteranceMs: 400, minSpeechMs: 40, frameMs: FRAME_MS });
    const events = feed(ep, SPEECH, 40);
    const end = events.find((e) => e.type === "speech_end");
    assert.ok(end?.type === "speech_end");
    assert.equal(end.reason, "max_duration");
  });

  it("is reusable across turns", () => {
    const ep = new Endpointer({ silenceMs: 200, minSpeechMs: 40, frameMs: FRAME_MS });
    for (let turn = 0; turn < 3; turn += 1) {
      const start = feed(ep, SPEECH, 5);
      assert.equal(start[0]?.type, "speech_start", `turn ${turn}`);
      const end = feed(ep, SILENCE, 15);
      assert.equal(end[0]?.type, "speech_end", `turn ${turn}`);
    }
  });

  it("stays quiet on a silent line", () => {
    const ep = new Endpointer({ frameMs: FRAME_MS });
    assert.deepEqual(feed(ep, SILENCE, 200), []);
  });
});
