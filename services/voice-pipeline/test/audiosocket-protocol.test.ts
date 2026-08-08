import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AudioSocketParser,
  AudioSocketType,
  encodeAudio,
  encodeTerminate,
  formatUuid,
} from "../src/audio/audiosocket-protocol.js";

function frame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(3);
  header.writeUInt8(type, 0);
  header.writeUInt16BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

const UUID_BYTES = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
const AUDIO = Buffer.alloc(320, 7);

describe("formatUuid", () => {
  it("renders 16 bytes canonically", () => {
    assert.equal(formatUuid(UUID_BYTES), "01234567-89ab-cdef-0123-456789abcdef");
  });
});

describe("encodeAudio", () => {
  it("writes a 3-byte header with a big-endian length", () => {
    const encoded = encodeAudio(AUDIO);
    assert.equal(encoded.readUInt8(0), AudioSocketType.Audio);
    assert.equal(encoded.readUInt16BE(1), 320);
    assert.equal(encoded.length, 323);
    assert.deepEqual(encoded.subarray(3), AUDIO);
  });

  it("encodes terminate as an empty frame", () => {
    const encoded = encodeTerminate();
    assert.equal(encoded.length, 3);
    assert.equal(encoded.readUInt8(0), AudioSocketType.Terminate);
    assert.equal(encoded.readUInt16BE(1), 0);
  });
});

describe("AudioSocketParser", () => {
  it("parses a whole frame", () => {
    const parser = new AudioSocketParser();
    const frames = parser.push(frame(AudioSocketType.Uuid, UUID_BYTES));
    assert.deepEqual(frames, [{ type: "uuid", uuid: "01234567-89ab-cdef-0123-456789abcdef" }]);
    assert.equal(parser.pending, 0);
  });

  it("parses several frames arriving in one packet", () => {
    const parser = new AudioSocketParser();
    const frames = parser.push(
      Buffer.concat([
        frame(AudioSocketType.Uuid, UUID_BYTES),
        frame(AudioSocketType.Audio, AUDIO),
        frame(AudioSocketType.Terminate, Buffer.alloc(0)),
      ]),
    );
    assert.equal(frames.length, 3);
    assert.equal(frames[0]?.type, "uuid");
    assert.equal(frames[1]?.type, "audio");
    assert.equal(frames[2]?.type, "terminate");
  });

  it("reassembles a frame split across reads", () => {
    // The case that corrupts audio rather than failing loudly.
    const parser = new AudioSocketParser();
    const whole = frame(AudioSocketType.Audio, AUDIO);
    assert.deepEqual(parser.push(whole.subarray(0, 100)), []);
    assert.equal(parser.pending, 100);
    const frames = parser.push(whole.subarray(100));
    assert.equal(frames.length, 1);
    assert.ok(frames[0]?.type === "audio");
    assert.deepEqual(frames[0].payload, AUDIO);
  });

  it("handles a header split across reads", () => {
    const parser = new AudioSocketParser();
    const whole = frame(AudioSocketType.Audio, AUDIO);
    assert.deepEqual(parser.push(whole.subarray(0, 2)), []); // half a header
    const frames = parser.push(whole.subarray(2));
    assert.equal(frames.length, 1);
    assert.ok(frames[0]?.type === "audio");
    assert.deepEqual(frames[0].payload, AUDIO);
  });

  it("survives byte-at-a-time delivery", () => {
    const parser = new AudioSocketParser();
    const whole = Buffer.concat([
      frame(AudioSocketType.Uuid, UUID_BYTES),
      frame(AudioSocketType.Audio, AUDIO),
    ]);
    const collected = [];
    for (const byte of whole) {
      collected.push(...parser.push(Buffer.from([byte])));
    }
    assert.equal(collected.length, 2);
    assert.equal(collected[0]?.type, "uuid");
    assert.equal(collected[1]?.type, "audio");
  });

  it("copies audio payloads so later reads cannot corrupt them", () => {
    const parser = new AudioSocketParser();
    const chunk = frame(AudioSocketType.Audio, Buffer.alloc(4, 1));
    const frames = parser.push(chunk);
    assert.ok(frames[0]?.type === "audio");
    const captured = frames[0].payload;
    chunk.fill(9); // simulate the socket reusing its buffer
    assert.deepEqual(captured, Buffer.alloc(4, 1));
  });

  it("reports unknown frame types instead of desynchronising", () => {
    const parser = new AudioSocketParser();
    const frames = parser.push(
      Buffer.concat([frame(0x42, Buffer.from([1, 2])), frame(AudioSocketType.Terminate, Buffer.alloc(0))]),
    );
    assert.equal(frames[0]?.type, "unknown");
    // The stream stays aligned, so the next frame still parses.
    assert.equal(frames[1]?.type, "terminate");
  });

  it("keeps an empty audio frame from stalling the stream", () => {
    const parser = new AudioSocketParser();
    const frames = parser.push(frame(AudioSocketType.Audio, Buffer.alloc(0)));
    assert.equal(frames.length, 1);
    assert.equal(parser.pending, 0);
  });
});
