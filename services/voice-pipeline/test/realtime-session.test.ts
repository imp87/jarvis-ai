import assert from "node:assert/strict";
import test from "node:test";
import { resamplePcm16 } from "../src/realtime-session.js";

test("resamplePcm16 preserves a 20 ms 16 kHz frame duration at 24 kHz", () => {
  const input = Buffer.alloc(640);
  for (let i = 0; i < 320; i += 1) input.writeInt16LE(i * 20 - 3_000, i * 2);
  const output = resamplePcm16(input, 16_000, 24_000);
  assert.equal(output.length, 960);
  assert.equal(output.readInt16LE(0), -3_000);
  assert.equal(output.readInt16LE(output.length - 2), input.readInt16LE(input.length - 2));
});

test("resamplePcm16 restores a 24 kHz frame to the telephony frame size", () => {
  const input = Buffer.alloc(960, 0x12);
  assert.equal(resamplePcm16(input, 24_000, 16_000).length, 640);
});
