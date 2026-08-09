import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { safeEqual, type Logger } from "@jarvis/shared";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { FRAME_MS, frameBytesFor, type CallTransport } from "../transport.js";
import type { PendingCall } from "./audiosocket.js";

const SAMPLE_RATE = 16_000;
const FRAME_BYTES = frameBytesFor(SAMPLE_RATE);
const MAX_BUFFERED_AUDIO_BYTES = SAMPLE_RATE * 2 * 10;

interface MediaStart {
  event: "MEDIA_START";
  connection_id: string;
  channel_id: string;
  format: string;
  optimal_frame_size: number;
  ptime: number;
  channel_variables?: Record<string, string | undefined>;
}

interface MediaEvent {
  event?: string;
}

/**
 * Asterisk chan_websocket media bridge.
 *
 * Unlike the AudioSocket dialplan application, this transport carries slin16
 * end-to-end. That retains the speech detail G.722 provides instead of forcing
 * every telephone call through 8 kHz before it reaches the recogniser.
 */
class WebSocketMediaTransport implements CallTransport {
  readonly sampleRate = SAMPLE_RATE;
  direction: "inbound" | "outbound" = "inbound";
  remoteNumber: string | null = null;

  private audioHandler: ((frame: Buffer) => void) | undefined;
  private hangupHandler: (() => void) | undefined;
  private readonly waiters: Array<() => void> = [];
  private inbound: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private closed = false;

  constructor(
    readonly callId: string,
    private readonly socket: WebSocket,
    private readonly logger: Logger,
  ) {}

  onAudio(handler: (frame: Buffer) => void): void {
    this.audioHandler = handler;
  }

  onHangup(handler: () => void): void {
    this.hangupHandler = handler;
  }

  deliver(chunk: Buffer): void {
    if (this.closed) return;
    this.inbound = this.inbound.length === 0 ? chunk : Buffer.concat([this.inbound, chunk]);
    if (this.inbound.length > MAX_BUFFERED_AUDIO_BYTES) {
      this.logger.warn(
        { callId: this.callId, bufferedBytes: this.inbound.length },
        "discarding implausibly large websocket media buffer",
      );
      this.inbound = Buffer.alloc(0);
      return;
    }

    while (this.inbound.length >= FRAME_BYTES) {
      const frame = this.inbound.subarray(0, FRAME_BYTES);
      this.inbound = this.inbound.subarray(FRAME_BYTES);
      this.audioHandler?.(frame);
    }
  }

  handleControl(event: MediaEvent): void {
    if (event.event === "QUEUE_DRAINED") {
      const waiters = this.waiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  async send(pcm: Buffer): Promise<void> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    if (pcm.length % FRAME_BYTES !== 0) {
      throw new Error(
        `slin16 media must use ${FRAME_BYTES}-byte frames, got ${pcm.length} bytes`,
      );
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.send(pcm, { binary: true }, (err) => (err ? reject(err) : resolve()));
    });
  }

  async flush(): Promise<void> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    const drained = new Promise<void>((resolve) => this.waiters.push(resolve));
    this.sendControl({ command: "REPORT_QUEUE_DRAINED" });
    // A missing event must not leave a live SIP call stuck forever.
    await Promise.race([drained, delay(5_000)]);
  }

  stopSending(): void {
    this.sendControl({ command: "FLUSH_MEDIA" });
  }

  async hangup(): Promise<void> {
    if (this.closed) return;
    this.sendControl({ command: "HANGUP" });
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve();
    this.hangupHandler?.();
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }

  private sendControl(body: Record<string, string>): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(body));
  }
}

/** Accepts a fresh authenticated Asterisk WebSocket connection for each call. */
export class WebSocketMediaServer {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly pending = new Map<string, PendingCall>();
  private readonly clients = new Set<WebSocket>();
  private server: HttpServer | undefined;

  constructor(
    private readonly serviceToken: string,
    private readonly logger: Logger,
    private readonly onCall: (transport: CallTransport, pending: PendingCall) => Promise<void>,
    private readonly pendingTtlMs = 60_000,
    /**
     * Reports an authorisation that expired unused.
     *
     * Placing a call is fire-and-forget — a call file is written and Asterisk
     * dials it later, or fails to. Without telling the orchestrator, the call
     * log stays on `dialing` forever, and because the budget counts `dialing`,
     * a call that never rang permanently consumes one of the day's allowance.
     */
    private readonly onExpired?: (call: PendingCall) => void,
  ) {
    this.wss.on("connection", (socket) => this.handleConnection(socket));
  }

  /** Attach after Express has created its HTTP listener. */
  attach(server: HttpServer): void {
    if (this.server) throw new Error("websocket media server is already attached");
    this.server = server;
    this.server.on("upgrade", this.onUpgrade);
  }

  expect(call: PendingCall): void {
    this.pending.set(call.callId, call);
    setTimeout(() => {
      if (this.pending.delete(call.callId)) {
        this.logger.warn({ callId: call.callId }, "authorised call was never connected");
        this.onExpired?.(call);
      }
    }, this.pendingTtlMs).unref();
  }

  async close(): Promise<void> {
    this.server?.off("upgrade", this.onUpgrade);
    for (const client of this.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private readonly onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/v1/media" || !safeEqual(url.searchParams.get("token") ?? "", this.serviceToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit("connection", ws, request));
  };

  private handleConnection(socket: WebSocket): void {
    let transport: WebSocketMediaTransport | undefined;
    this.clients.add(socket);

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        if (!transport) {
          this.logger.warn("received websocket media before MEDIA_START");
          socket.close();
          return;
        }
        transport.deliver(toBuffer(data));
        return;
      }

      const event = parseControl(data);
      if (!event) {
        this.logger.warn("received malformed Asterisk websocket control message");
        socket.close();
        return;
      }

      if (event.event === "MEDIA_START") {
        if (transport) {
          this.logger.warn("received duplicate MEDIA_START event");
          socket.close();
          return;
        }
        const start = event as MediaStart;
        const callId = start.channel_variables?.["JARVIS_CALL_ID"];
        if (!callId || start.format !== "slin16") {
          this.logger.error(
            {
              callId,
              format: start.format,
              channelVariableKeys: Object.keys(start.channel_variables ?? {}).sort(),
            },
            "websocket media did not start with the required call id and slin16 format",
          );
          socket.close();
          return;
        }
        const pending = this.pending.get(callId);
        if (!pending) {
          this.logger.warn({ callId }, "websocket media connection has an unknown call id");
          socket.close();
          return;
        }
        this.pending.delete(callId);

        transport = new WebSocketMediaTransport(callId, socket, this.logger);
        transport.direction = pending.direction;
        transport.remoteNumber = pending.remoteNumber;
        this.logger.info(
          { callId, format: start.format, ptime: start.ptime, frameBytes: start.optimal_frame_size },
          "wideband websocket media connected",
        );
        void this.onCall(transport, pending).catch((err: unknown) => {
          this.logger.error({ callId, err: String(err) }, "websocket media call handler failed");
          transport?.close();
        });
        return;
      }

      transport?.handleControl(event);
    });

    socket.on("close", () => {
      this.clients.delete(socket);
      transport?.close();
    });
    socket.on("error", (err) => {
      this.logger.warn({ err: String(err) }, "Asterisk media websocket error");
      transport?.close();
    });
  }
}

function parseControl(data: RawData): MediaEvent | null {
  try {
    const value: unknown = JSON.parse(toBuffer(data).toString("utf8"));
    return value && typeof value === "object" ? (value as MediaEvent) : null;
  } catch {
    return null;
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
