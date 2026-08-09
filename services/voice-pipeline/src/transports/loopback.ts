import { randomUUID } from "node:crypto";
import { FRAME_BYTES, FRAME_MS, TELEPHONY_SAMPLE_RATE, type CallTransport } from "../transport.js";

/**
 * A call made of audio files instead of a phone line.
 *
 * The FritzBox is not reachable from a development machine, so without this the
 * conversation engine could only ever be tested by placing a real call — which
 * makes every failure ambiguous between the agent and the telephony. Here the
 * agent runs exactly as it will on a real call: same frame size, same sample
 * rate, same ordering.
 *
 * Frames are delivered on a timer at real speed by default so endpointing
 * behaves as it would on a line; `speed` shortens the wait for tests.
 */
export class LoopbackTransport implements CallTransport {
  readonly callId = randomUUID();
  readonly direction: "inbound" | "outbound";
  readonly remoteNumber: string | null;
  readonly sampleRate = TELEPHONY_SAMPLE_RATE;

  private audioHandler: ((frame: Buffer) => void) | undefined;
  private hangupHandler: (() => void) | undefined;
  private readonly outbound: Buffer[] = [];
  private stopped = false;

  constructor(
    private readonly options: {
      direction?: "inbound" | "outbound";
      remoteNumber?: string | null;
      /** 1 = real time. 0 delivers frames as fast as the event loop allows. */
      speed?: number;
    } = {},
  ) {
    this.direction = options.direction ?? "inbound";
    this.remoteNumber = options.remoteNumber ?? null;
  }

  onAudio(handler: (frame: Buffer) => void): void {
    this.audioHandler = handler;
  }

  onHangup(handler: () => void): void {
    this.hangupHandler = handler;
  }

  async send(pcm: Buffer): Promise<void> {
    this.outbound.push(Buffer.from(pcm));
  }

  async flush(): Promise<void> {
    // Nothing is queued in loopback; send() already recorded everything.
  }

  stopSending(): void {
    // Nothing is buffered downstream in loopback; the recording keeps whatever
    // was already produced, which is what a real barge-in would leave behind.
  }

  async hangup(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.hangupHandler?.();
  }

  /** Everything the agent said, as one raw 8 kHz PCM buffer. */
  recordedOutput(): Buffer {
    return Buffer.concat(this.outbound);
  }

  /**
   * Feeds caller audio, then keeps the line open with silence so the endpointer
   * sees the pause that closes the utterance — exactly as a real line would.
   */
  async play(pcm: Buffer, trailingSilenceMs = 1200): Promise<void> {
    const silenceFrames = Math.ceil(trailingSilenceMs / FRAME_MS);
    const silence = Buffer.alloc(FRAME_BYTES);
    const speed = this.options.speed ?? 1;

    for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
      if (this.stopped) return;
      const slice = pcm.subarray(offset, offset + FRAME_BYTES);
      const frame =
        slice.length === FRAME_BYTES
          ? slice
          : Buffer.concat([slice, Buffer.alloc(FRAME_BYTES - slice.length)]);
      this.audioHandler?.(frame);
      if (speed > 0) await delay(FRAME_MS / speed);
    }

    for (let i = 0; i < silenceFrames; i += 1) {
      if (this.stopped) return;
      this.audioHandler?.(silence);
      if (speed > 0) await delay(FRAME_MS / speed);
    }
  }

  /** Holds the line open, so the agent has time to answer. */
  async idle(ms: number): Promise<void> {
    const frames = Math.ceil(ms / FRAME_MS);
    const silence = Buffer.alloc(FRAME_BYTES);
    const speed = this.options.speed ?? 1;
    for (let i = 0; i < frames; i += 1) {
      if (this.stopped) return;
      this.audioHandler?.(silence);
      if (speed > 0) await delay(FRAME_MS / speed);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
