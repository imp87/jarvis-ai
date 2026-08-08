/**
 * Asterisk AudioSocket wire format.
 *
 *   [type: 1 byte][length: 2 bytes big-endian][payload: length bytes]
 *
 * TCP does not preserve message boundaries: a single read can contain half a
 * frame, three frames, or a header split across two packets. Parsing has to be
 * incremental, and getting that wrong produces audio that is subtly corrupted
 * rather than obviously broken — which is why this lives in its own file with
 * its own tests instead of inline in the socket handler.
 */

export const AudioSocketType = {
  /** Far end hung up. */
  Terminate: 0x00,
  /** 16-byte call identifier, sent once when the connection opens. */
  Uuid: 0x01,
  /** Signed linear 16-bit PCM, 8 kHz mono. */
  Audio: 0x10,
  Error: 0xff,
} as const;

export type AudioSocketFrame =
  | { type: "terminate" }
  | { type: "uuid"; uuid: string }
  | { type: "audio"; payload: Buffer }
  | { type: "error"; code: number }
  | { type: "unknown"; rawType: number; payload: Buffer };

const HEADER_BYTES = 3;
/** Refuse absurd lengths rather than allocating on a malformed stream. */
const MAX_PAYLOAD = 65_535;

/** Formats 16 raw bytes as a canonical UUID string. */
export function formatUuid(bytes: Buffer): string {
  const hex = bytes.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function encodeAudio(pcm: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(AudioSocketType.Audio, 0);
  header.writeUInt16BE(pcm.length, 1);
  return Buffer.concat([header, pcm]);
}

export function encodeTerminate(): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(AudioSocketType.Terminate, 0);
  header.writeUInt16BE(0, 1);
  return header;
}

/**
 * Incremental frame parser. Feed whatever TCP delivered; get back the complete
 * frames it contained, keeping any partial tail for the next call.
 */
export class AudioSocketParser {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): AudioSocketFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: AudioSocketFrame[] = [];

    for (;;) {
      if (this.buffer.length < HEADER_BYTES) break;
      const type = this.buffer.readUInt8(0);
      const length = this.buffer.readUInt16BE(1);

      if (length > MAX_PAYLOAD) {
        // Cannot resynchronise a byte stream we no longer understand.
        throw new Error(`AudioSocket frame claims ${length} bytes, which is out of range`);
      }
      if (this.buffer.length < HEADER_BYTES + length) break;

      const payload = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);

      switch (type) {
        case AudioSocketType.Terminate:
          frames.push({ type: "terminate" });
          break;
        case AudioSocketType.Uuid:
          frames.push({ type: "uuid", uuid: formatUuid(payload) });
          break;
        case AudioSocketType.Audio:
          // Copy: the slice references a buffer we are about to reuse.
          frames.push({ type: "audio", payload: Buffer.from(payload) });
          break;
        case AudioSocketType.Error:
          frames.push({ type: "error", code: payload.length > 0 ? payload.readUInt8(0) : 0 });
          break;
        default:
          frames.push({ type: "unknown", rawType: type, payload: Buffer.from(payload) });
      }
    }

    return frames;
  }

  /** Bytes held back waiting for the rest of a frame. */
  get pending(): number {
    return this.buffer.length;
  }
}
