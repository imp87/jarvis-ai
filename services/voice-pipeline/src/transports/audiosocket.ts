import { createServer, type Server, type Socket } from "node:net";
import type { Logger } from "@jarvis/shared";
import {
  AudioSocketParser,
  encodeAudio,
  encodeTerminate,
} from "../audio/audiosocket-protocol.js";
import { TELEPHONY_SAMPLE_RATE, type CallTransport } from "../transport.js";

/** ~500 ms of audio: enough to absorb synthesis jitter, short enough that the
 * session does not race ahead of what the caller is hearing. */
const MAX_QUEUED_FRAMES = 25;
/**
 * How long a connected call may go without a single frame from Asterisk before
 * we call it broken.
 *
 * This is not a tuning knob but a diagnostic: because AudioSocket is lock-step,
 * a call whose RTP never arrives produces *no* symptom here — the session sits
 * in `say()` forever, the channel stays Up in Asterisk, and nothing is logged.
 * That failure is indistinguishable from a hang in synthesis unless it is named.
 */
const NO_AUDIO_TIMEOUT_MS = 3000;

/**
 * A live call, carried over Asterisk's AudioSocket.
 *
 * Asterisk owns SIP registration, RTP and codec negotiation; this side receives
 * 8 kHz signed-linear PCM on a TCP socket. That division is the whole reason for
 * choosing Asterisk: the format arriving here is exactly what `@jarvis/speech`
 * already produces and consumes.
 */
class AudioSocketTransport implements CallTransport {
  direction: "inbound" | "outbound" = "inbound";
  remoteNumber: string | null = null;
  readonly sampleRate = TELEPHONY_SAMPLE_RATE;

  private audioHandler: ((frame: Buffer) => void) | undefined;
  private hangupHandler: (() => void) | undefined;
  private closed = false;

  /**
   * Speech waiting to go out, one transport-sized frame per entry.
   *
   * Asterisk's AudioSocket is lock-step: for every frame it sends it blocks
   * waiting for exactly one frame back, and gives up if none arrives. Writing
   * only while the agent speaks therefore stalls the call — the symptom is a
   * connected call with no audio at all, followed by
   * "Failed to receive frame from AudioSocket message". So every inbound frame
   * is answered, with queued speech if there is any and silence otherwise.
   */
  private readonly outgoing: Buffer[] = [];
  private readonly silence: Buffer;
  private readonly waiters: Array<() => void> = [];
  private framesReceived = 0;
  private lastPumpAt = Date.now();

  constructor(
    readonly callId: string,
    private readonly socket: Socket,
    private readonly logger: Logger,
    frameBytes = 320,
  ) {
    this.silence = Buffer.alloc(frameBytes);
    setTimeout(() => {
      if (this.closed || this.framesReceived > 0) return;
      this.logger.error(
        { callId: this.callId },
        "no audio from Asterisk on a connected call — the channel is up but no RTP " +
          "is arriving, so nothing can be played to the caller either. Check that " +
          "Asterisk's SDP advertises an address the phone system can actually reach.",
      );
    }, NO_AUDIO_TIMEOUT_MS).unref();
  }

  onAudio(handler: (frame: Buffer) => void): void {
    this.audioHandler = handler;
  }

  onHangup(handler: () => void): void {
    this.hangupHandler = handler;
  }

  /**
   * Called for each frame Asterisk sends: hand it to the session, then answer
   * with one frame. Keeping the reply here — rather than on a timer — means the
   * outgoing stream is paced by the call itself and cannot drift.
   */
  deliver(frame: Buffer): void {
    this.framesReceived += 1;
    this.audioHandler?.(frame);
    this.pump();
  }

  private pump(): void {
    if (this.closed) return;
    const next = this.outgoing.shift() ?? this.silence;
    this.socket.write(encodeAudio(next));
    this.lastPumpAt = Date.now();
    this.releaseWaiters();
  }

  private releaseWaiters(): void {
    if (this.waiters.length === 0) return;
    // Space for more audio, or nothing left to play: either way, wake them.
    if (this.outgoing.length < MAX_QUEUED_FRAMES || this.outgoing.length === 0) {
      const waiting = this.waiters.splice(0);
      for (const resolve of waiting) resolve();
    }
  }

  /**
   * Queues one frame, blocking only when the buffer is already deep enough.
   *
   * A little buffering absorbs synthesis jitter; unlimited buffering would let
   * the session queue a whole reply, conclude it had finished speaking, and
   * start listening while the caller is still hearing it.
   */
  async send(pcm: Buffer): Promise<void> {
    if (this.closed) return;
    this.outgoing.push(pcm);
    if (this.outgoing.length < MAX_QUEUED_FRAMES) return;
    await this.wait();
  }

  /**
   * Resolves once every queued frame has gone out, or once it is clear they
   * never will.
   *
   * The pump only runs when Asterisk sends us something, so a stalled call would
   * otherwise leave the session waiting here forever with the greeting still
   * queued — no error, no hangup, no log line. Giving up keeps the session alive
   * to hang up and report instead.
   */
  async flush(): Promise<void> {
    while (!this.closed && this.outgoing.length > 0) {
      if (Date.now() - this.lastPumpAt > NO_AUDIO_TIMEOUT_MS) {
        this.logger.warn(
          { callId: this.callId, dropped: this.outgoing.length },
          "far end stopped consuming audio; abandoning the rest of this reply",
        );
        this.outgoing.length = 0;
        return;
      }
      await this.wait();
    }
  }

  private wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      // The pump only runs while the far end sends frames. If the call drops,
      // nothing would ever wake this.
      setTimeout(resolve, 5000).unref();
    });
  }

  /** Drops queued speech — the mechanism barge-in will use. */
  stopSending(): void {
    this.outgoing.length = 0;
    this.releaseWaiters();
  }

  async hangup(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(encodeTerminate());
    } catch {
      // The far end may already be gone; closing below is what matters.
    }
    this.socket.end();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hangupHandler?.();
  }

  fireHangup(): void {
    this.hangupHandler?.();
  }
}

export interface PendingCall {
  /** Correlates the dialplan's HTTP request with the socket Asterisk opens next. */
  callId: string;
  direction: "inbound" | "outbound";
  remoteNumber: string | null;
  /** The authorised user's E.164 number, used as the channel identity. */
  channelUserId: string;
  createdAt: number;
}

export type CallHandler = (transport: CallTransport, pending: PendingCall) => Promise<void>;

/**
 * Accepts AudioSocket connections from Asterisk and pairs each with the call
 * that was authorised beforehand over HTTP.
 *
 * The UUID is the only thing AudioSocket carries — no caller ID, no direction.
 * So the dialplan asks this service for permission first, gets a UUID back, and
 * the socket that follows is matched to it. A socket whose UUID was never issued
 * is dropped: without that, anything able to reach the port could start a call.
 */
export class AudioSocketServer {
  private server: Server | undefined;
  private readonly pending = new Map<string, PendingCall>();

  constructor(
    private readonly logger: Logger,
    private readonly onCall: CallHandler,
    /** Unclaimed authorisations expire, so a stale UUID cannot be replayed later. */
    private readonly pendingTtlMs = 60_000,
    /**
     * Reports an authorisation that expired unused. Without it the orchestrator
     * never learns the call did not happen, leaves the log on `dialing`, and —
     * since the budget counts `dialing` — retires one of the day's calls for a
     * call that never rang.
     */
    private readonly onExpired?: (call: PendingCall) => void,
  ) {}

  expect(call: PendingCall): void {
    this.pending.set(call.callId, call);
    setTimeout(() => {
      if (this.pending.delete(call.callId)) {
        this.logger.warn({ callId: call.callId }, "authorised call was never connected");
        this.onExpired?.(call);
      }
    }, this.pendingTtlMs).unref();
  }

  listen(port: number, host = "0.0.0.0"): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((socket) => this.handleSocket(socket));
      this.server.listen(port, host, () => {
        this.logger.info({ port }, "AudioSocket server listening");
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private handleSocket(socket: Socket): void {
    const parser = new AudioSocketParser();
    let transport: AudioSocketTransport | undefined;
    // Nagle would batch 20 ms frames and add jitter to the far end.
    socket.setNoDelay(true);

    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = parser.push(chunk);
      } catch (err) {
        this.logger.error({ err: String(err) }, "malformed AudioSocket stream; dropping call");
        socket.destroy();
        return;
      }

      for (const frame of frames) {
        switch (frame.type) {
          case "uuid": {
            const pending = this.pending.get(frame.uuid);
            if (!pending) {
              this.logger.warn(
                { uuid: frame.uuid },
                "AudioSocket connection with an unknown call id; rejecting",
              );
              socket.destroy();
              return;
            }
            this.pending.delete(frame.uuid);

            transport = new AudioSocketTransport(pending.callId, socket, this.logger);
            transport.direction = pending.direction;
            transport.remoteNumber = pending.remoteNumber;
            void this.onCall(transport, pending).catch((err: unknown) => {
              this.logger.error(
                { callId: pending.callId, err: String(err) },
                "call handler failed",
              );
              socket.destroy();
            });
            break;
          }
          case "audio":
            transport?.deliver(frame.payload);
            break;
          case "terminate":
            transport?.fireHangup();
            socket.end();
            break;
          case "error":
            this.logger.warn({ code: frame.code }, "AudioSocket reported an error");
            break;
          default:
            break;
        }
      }
    });

    socket.on("error", (err) => {
      this.logger.warn({ err: String(err) }, "AudioSocket connection error");
      transport?.close();
    });
    socket.on("close", () => transport?.close());
  }
}
