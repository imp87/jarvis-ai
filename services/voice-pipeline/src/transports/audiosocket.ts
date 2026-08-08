import { createServer, type Server, type Socket } from "node:net";
import type { Logger } from "@jarvis/shared";
import {
  AudioSocketParser,
  encodeAudio,
  encodeTerminate,
} from "../audio/audiosocket-protocol.js";
import type { CallTransport } from "../transport.js";

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

  private audioHandler: ((frame: Buffer) => void) | undefined;
  private hangupHandler: (() => void) | undefined;
  private closed = false;
  private cancelSending = false;

  constructor(
    readonly callId: string,
    private readonly socket: Socket,
    private readonly logger: Logger,
  ) {}

  onAudio(handler: (frame: Buffer) => void): void {
    this.audioHandler = handler;
  }

  onHangup(handler: () => void): void {
    this.hangupHandler = handler;
  }

  deliver(frame: Buffer): void {
    this.audioHandler?.(frame);
  }

  async send(pcm: Buffer): Promise<void> {
    if (this.closed || this.cancelSending) return;
    await new Promise<void>((resolve) => {
      // Respect backpressure: Asterisk consumes at real time, so without this a
      // long reply would be buffered in memory and arrive as a burst.
      const ok = this.socket.write(encodeAudio(pcm), () => resolve());
      if (!ok) this.socket.once("drain", () => resolve());
    });
  }

  stopSending(): void {
    this.cancelSending = true;
  }

  resumeSending(): void {
    this.cancelSending = false;
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
  ) {}

  expect(call: PendingCall): void {
    this.pending.set(call.callId, call);
    setTimeout(() => {
      if (this.pending.delete(call.callId)) {
        this.logger.warn({ callId: call.callId }, "authorised call was never connected");
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
