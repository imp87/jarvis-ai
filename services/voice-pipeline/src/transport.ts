import type { EventEmitter } from "node:events";

/**
 * What the conversation engine needs from a call, and nothing more.
 *
 * Keeping this narrow is what makes the engine testable without a PBX: the
 * loopback transport reads a WAV file and writes another, the AudioSocket
 * transport talks to Asterisk, and neither one is visible to the session logic.
 */
export interface CallTransport {
  readonly callId: string;
  readonly direction: "inbound" | "outbound";
  /** Caller ID for inbound, dialled number for outbound. Null when withheld. */
  readonly remoteNumber: string | null;

  /** 8 kHz, 16-bit little-endian mono PCM, typically 20 ms per frame. */
  onAudio(handler: (frame: Buffer) => void): void;
  onHangup(handler: () => void): void;

  /** Send audio to the caller. Resolves once handed to the transport. */
  send(pcm: Buffer): Promise<void>;
  /** Stop any audio currently being sent — the basis for barge-in. */
  stopSending(): void;
  hangup(): Promise<void>;
}

export const TELEPHONY_SAMPLE_RATE = 8000;
export const FRAME_MS = 20;
/** 160 samples × 2 bytes at 8 kHz. */
export const FRAME_BYTES = (TELEPHONY_SAMPLE_RATE * FRAME_MS * 2) / 1000;

/** Splits an arbitrary PCM buffer into transport-sized frames. */
export function toFrames(pcm: Buffer, frameBytes = FRAME_BYTES): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    const slice = pcm.subarray(offset, offset + frameBytes);
    if (slice.length === frameBytes) {
      frames.push(slice);
    } else {
      // Pad the tail so the far end always receives whole frames.
      const padded = Buffer.alloc(frameBytes);
      slice.copy(padded);
      frames.push(padded);
    }
  }
  return frames;
}

export type TransportEvents = EventEmitter;
