import { WebSocket, type RawData } from "ws";
import { frameBytesFor, type CallTransport } from "./transport.js";
import type { OrchestratorClient } from "./orchestrator.js";
import type { Logger } from "@jarvis/shared";
import type { SessionResult } from "./session.js";

const OPENAI_SAMPLE_RATE = 24_000;
const OPENAI_FRAME_BYTES = frameBytesFor(OPENAI_SAMPLE_RATE);

export interface RealtimeSessionOptions {
  apiKey: string;
  model: string;
  voice: string;
  greeting: string;
  idleHangupMs: number;
}

type RealtimeEvent = {
  type?: string;
  delta?: string;
  error?: { message?: string; code?: string; type?: string };
  name?: string;
  call_id?: string;
  arguments?: string;
  item?: { type?: string; name?: string; call_id?: string; arguments?: string };
  transcript?: string;
};

/**
 * Continuous OpenAI Realtime bridge for a telephone call.
 *
 * Audio is streamed both ways in 20 ms frames. The Realtime model only handles
 * listening, VAD and speech generation; every recognised caller utterance is
 * delegated to the existing orchestrator, so its MCP tools, memory and call
 * safety policies remain the single source of truth.
 */
export class RealtimeCallSession {
  private socket: WebSocket | undefined;
  private doneResolver: ((result: SessionResult) => void) | undefined;
  private finished = false;
  private endedBecause: SessionResult["endedBecause"] = "hangup";
  private turns = 0;
  private conversationId: string | undefined;
  private lastActivity = Date.now();
  private remoteAudio: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private playback = Promise.resolve();
  private playbackGeneration = 0;
  private pendingEndCall: { reason: string } | undefined;
  private readonly handledFunctionCalls = new Set<string>();

  constructor(
    private readonly transport: CallTransport,
    private readonly orchestrator: OrchestratorClient,
    private readonly channelUserId: string,
    private readonly logger: Logger,
    private readonly options: RealtimeSessionOptions,
  ) {}

  async run(): Promise<SessionResult> {
    const done = new Promise<SessionResult>((resolve) => {
      this.doneResolver = resolve;
    });

    this.transport.onAudio((frame) => this.onAudio(frame));
    this.transport.onHangup(() => this.finish("hangup"));

    await this.connect();
    this.configureSession();
    this.requestGreeting();

    const idleTimer = setInterval(() => {
      if (this.finished) return;
      const idleFor = Date.now() - this.lastActivity;
      if (idleFor > this.options.idleHangupMs) {
        this.logger.info({ callId: this.transport.callId, idleFor }, "ending realtime call after silence");
        void this.transport.hangup();
        this.finish("idle");
      }
    }, 1_000);

    const result = await done;
    clearInterval(idleTimer);
    this.socket?.close();
    return result;
  }

  private async connect(): Promise<void> {
    const url = new URL("wss://api.openai.com/v1/realtime");
    url.searchParams.set("model", this.options.model);

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        handshakeTimeout: 15_000,
      });
      this.socket = socket;

      const timeout = setTimeout(() => reject(new Error("OpenAI Realtime connection timed out")), 16_000);
      socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      socket.on("message", (data) => this.onMessage(data));
      socket.on("error", (err) => {
        if (!this.finished) this.logger.warn({ callId: this.transport.callId, err: String(err) }, "realtime websocket error");
      });
      socket.on("close", () => {
        if (!this.finished) this.finish("error");
      });
    });
  }

  private configureSession(): void {
    this.send({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions:
          "You are Jarvis, Master's private butler and the real-time phone voice for his personal " +
          "assistant. Speak German naturally, concisely, confidently, and at a brisk conversational " +
          "pace; never draw out words. Be cool, capable, discreet, and lightly dry-witted, never " +
          "theatrical or servile. Use 'Master' naturally in the greeting and occasionally when it " +
          "fits, never as a verbal tic. " +
          "For every caller utterance that needs an answer, call jarvis_turn exactly once with its " +
          "faithful transcription. Do not answer the caller yourself before that function returns. " +
          "After it returns, speak the reply faithfully in the same butler persona. Never infer that " +
          "a call should end; the delegated Jarvis response controls that safely.",
        voice: this.options.voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "gpt-4o-mini-transcribe", language: "de" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.45,
          prefix_padding_ms: 300,
          silence_duration_ms: 650,
          create_response: true,
          interrupt_response: true,
          idle_timeout_ms: this.options.idleHangupMs,
        },
        tools: [
          {
            type: "function",
            name: "jarvis_turn",
            description:
              "Delegate the caller's complete, faithful utterance to Jarvis. Always use it before replying.",
            parameters: {
              type: "object",
              properties: {
                text: { type: "string", description: "Faithful German transcription of the caller." },
              },
              required: ["text"],
              additionalProperties: false,
            },
          },
        ],
        // Caller speech must be delegated. Otherwise the Realtime model can
        // answer from its own, intentionally tiny tool set and claim that it
        // has no MCP tools even though the orchestrator does.
        tool_choice: "required",
      },
    });
  }

  private requestGreeting(): void {
    this.send({
      type: "response.create",
      response: {
        modalities: ["audio"],
        tool_choice: "none",
        instructions:
          "Speak the following German text verbatim. Do not translate it, paraphrase it, add a " +
          `generic question, or call a tool: ${JSON.stringify(this.options.greeting)}`,
      },
    });
  }

  private onAudio(frame: Buffer): void {
    if (this.finished || this.socket?.readyState !== WebSocket.OPEN) return;
    const audio = resamplePcm16(frame, this.transport.sampleRate, OPENAI_SAMPLE_RATE);
    this.send({ type: "input_audio_buffer.append", audio: audio.toString("base64") });
  }

  private onMessage(data: RawData): void {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(toBuffer(data).toString("utf8")) as RealtimeEvent;
    } catch {
      this.logger.warn({ callId: this.transport.callId }, "received malformed realtime event");
      return;
    }

    switch (event.type) {
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (event.delta) this.queueRemoteAudio(Buffer.from(event.delta, "base64"));
        return;
      case "input_audio_buffer.speech_started":
        this.lastActivity = Date.now();
        this.interruptPlayback();
        return;
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript?.trim()) {
          this.logger.debug({ callId: this.transport.callId, transcript: event.transcript.trim() }, "realtime transcription completed");
        }
        return;
      case "response.function_call_arguments.done":
        void this.handleFunctionCall(event.name, event.call_id, event.arguments);
        return;
      case "response.output_item.done":
        if (event.item?.type === "function_call") {
          void this.handleFunctionCall(event.item.name, event.item.call_id, event.item.arguments);
        }
        return;
      case "response.done":
        void this.finishResponse();
        return;
      case "error":
        this.logger.error(
          { callId: this.transport.callId, error: event.error?.message, code: event.error?.code },
          "OpenAI Realtime rejected an event",
        );
        return;
      default:
        return;
    }
  }

  private async handleFunctionCall(name?: string, callId?: string, rawArguments?: string): Promise<void> {
    if (name !== "jarvis_turn" || !callId || this.handledFunctionCalls.has(callId) || this.finished) return;
    this.handledFunctionCalls.add(callId);

    let text = "";
    try {
      const parsed = JSON.parse(rawArguments ?? "{}") as { text?: unknown };
      text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    } catch {
      // The function result below gives the model a recoverable error.
    }

    let output: Record<string, unknown>;
    if (!text) {
      output = { error: "No usable caller transcription was supplied." };
    } else {
      try {
        const started = Date.now();
        const reply = await this.orchestrator.send({
          channelUserId: this.channelUserId,
          text,
          ...(this.conversationId ? { conversationId: this.conversationId } : {}),
        });
        this.conversationId = reply.conversationId;
        this.turns += 1;
        this.lastActivity = Date.now();
        if (reply.endCall) this.pendingEndCall = reply.endCall;
        output = { reply: reply.reply, ...(reply.endCall ? { endCall: true } : {}) };
        this.logger.info(
          { callId: this.transport.callId, turn: this.turns, heard: text, orchestratorMs: Date.now() - started },
          "realtime turn delegated",
        );
      } catch (err) {
        this.logger.error({ callId: this.transport.callId, err: String(err) }, "realtime delegation failed");
        output = { reply: "Entschuldigung, da ist bei mir gerade etwas schiefgelaufen." };
      }
    }

    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
    });
    this.send({
      type: "response.create",
      response: {
        modalities: ["audio"],
        // This response must read the already-authorised orchestrator result,
        // not start a second delegation loop.
        tool_choice: "none",
      },
    });
  }

  private queueRemoteAudio(chunk: Buffer): void {
    this.lastActivity = Date.now();
    this.remoteAudio = this.remoteAudio.length === 0 ? chunk : Buffer.concat([this.remoteAudio, chunk]);
    while (this.remoteAudio.length >= OPENAI_FRAME_BYTES) {
      const frame = this.remoteAudio.subarray(0, OPENAI_FRAME_BYTES);
      this.remoteAudio = this.remoteAudio.subarray(OPENAI_FRAME_BYTES);
      const telephoneFrame = resamplePcm16(frame, OPENAI_SAMPLE_RATE, this.transport.sampleRate);
      const generation = this.playbackGeneration;
      this.playback = this.playback.then(async () => {
        if (!this.finished && generation === this.playbackGeneration) await this.transport.send(telephoneFrame);
      });
    }
  }

  private interruptPlayback(): void {
    this.playbackGeneration += 1;
    this.remoteAudio = Buffer.alloc(0);
    this.transport.stopSending();
    this.send({ type: "response.cancel" });
  }

  private async finishResponse(): Promise<void> {
    await this.playback;
    await this.transport.flush();
    if (this.pendingEndCall && !this.finished) {
      const reason = this.pendingEndCall.reason;
      this.pendingEndCall = undefined;
      this.logger.info({ callId: this.transport.callId, reason }, "agent ended realtime call");
      this.finish("agent");
      await this.transport.hangup();
    }
  }

  private finish(reason: SessionResult["endedBecause"]): void {
    if (this.finished) return;
    this.finished = true;
    this.endedBecause = reason;
    this.doneResolver?.({ turns: this.turns, transcript: [], endedBecause: this.endedBecause });
  }

  private send(body: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(body));
  }
}

/** Resample signed 16-bit little-endian mono PCM without spawning ffmpeg per frame. */
export function resamplePcm16(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return Buffer.from(input);
  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples === 0) return Buffer.alloc(0);
  const outputSamples = Math.round((inputSamples * toRate) / fromRate);
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i += 1) {
    const source = (i * fromRate) / toRate;
    const lower = Math.floor(source);
    const upper = Math.min(lower + 1, inputSamples - 1);
    const fraction = source - lower;
    const a = input.readInt16LE(Math.min(lower, inputSamples - 1) * 2);
    const b = input.readInt16LE(upper * 2);
    output.writeInt16LE(Math.round(a + (b - a) * fraction), i * 2);
  }
  return output;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
