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
  /** Private, server-generated context for the first delegated caller turn. */
  outboundContext?: string | undefined;
  /**
   * Set when we called somebody who is not the owner.
   *
   * Turns then go to `/v1/calls/:id/turn`, whose authority comes from the call
   * record. The owner's inbound path cannot be used: it checks the identity
   * allowlist, and a stranger is by definition not on it — which is why every
   * third-party turn came back 403 and the assistant improvised as if it were
   * still talking to its owner.
   */
  thirdPartyCallId?: string | undefined;
}

type RealtimeEvent = {
  type?: string;
  event_id?: string;
  delta?: string;
  error?: { message?: string; code?: string; type?: string };
  name?: string;
  call_id?: string;
  arguments?: string;
  item?: { type?: string; name?: string; call_id?: string; arguments?: string };
  transcript?: string;
  session?: {
    voice?: string;
    audio?: { output?: { voice?: string } };
  };
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
  private outboundContextPending: string | undefined;
  // Barge-in fires on every caller utterance, including the ones where the
  // model is not speaking. Cancelling a response that is not running is
  // rejected by OpenAI, so track what is actually in flight.
  private responseActive = false;
  /**
   * True until the opening statement has been spoken in full.
   *
   * On an outbound call the opening is the entire point — it says who is
   * calling and why. The callee's "Hallo?" as they pick up is not an
   * interruption to respect: letting it cancel the greeting means the errand is
   * never stated, and the two utterances then talk over each other.
   */
  private openingStatementPending: boolean;
  private readonly handledFunctionCalls = new Set<string>();
  private sessionConfiguration:
    | { resolve: () => void; reject: (reason: Error) => void; timeout: NodeJS.Timeout }
    | undefined;

  constructor(
    private readonly transport: CallTransport,
    private readonly orchestrator: OrchestratorClient,
    private readonly channelUserId: string,
    private readonly logger: Logger,
    private readonly options: RealtimeSessionOptions,
  ) {
    this.outboundContextPending = options.outboundContext?.trim();
    // Only outbound calls have an opening worth protecting. An inbound caller
    // who talks over the greeting is genuinely interrupting.
    this.openingStatementPending = Boolean(options.thirdPartyCallId);
  }

  async run(): Promise<SessionResult> {
    const done = new Promise<SessionResult>((resolve) => {
      this.doneResolver = resolve;
    });

    this.transport.onAudio((frame) => this.onAudio(frame));
    this.transport.onHangup(() => this.finish("hangup"));

    try {
      await this.connect();
      // A voice is locked after the first audio output. Do not ask for the
      // greeting until OpenAI has acknowledged the session configuration;
      // otherwise the default voice can win the race and persist for the call.
      await this.configureSession();
      this.requestGreeting();
    } catch (err) {
      this.logger.error({ callId: this.transport.callId, err: String(err) }, "realtime session setup failed");
      this.finish("error");
      await this.transport.hangup().catch(() => undefined);
      return done;
    }

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

  /**
   * What the Realtime model itself is told about who it is talking to.
   *
   * This is separate from the orchestrator's system prompt and was the second
   * half of the same bug: even with delegation working, the model spoke the
   * delegated reply "in the same butler persona" — which addresses the far end
   * as Master. On a call to a stranger both had to change.
   */
  private voiceInstructions(): string {
    if (this.options.thirdPartyCallId) {
      return (
        "You are a digital assistant placing a call on behalf of your owner. THE PERSON ON THE " +
        "PHONE IS NOT YOUR OWNER: never say 'Master', never address them as if they were the " +
        "person who gave you the errand, and use polite German 'Sie' throughout. Speak German " +
        "naturally and concisely at a brisk conversational pace. " +
        "For every utterance that needs an answer, call jarvis_turn exactly once with its " +
        "faithful transcription. Do not answer yourself before that function returns. After it " +
        "returns, speak the reply faithfully and add nothing of your own — no promises, no " +
        "agreements, no details about your owner. Never infer that a call should end; the " +
        "delegated response controls that."
      );
    }
    return (
      "You are Jarvis, Master's private butler and the real-time phone voice for his personal " +
      "assistant. Speak German naturally, concisely, confidently, and at a brisk conversational " +
      "pace; never draw out words. Be cool, capable, discreet, and lightly dry-witted, never " +
      "theatrical or servile. Use 'Master' naturally in the greeting and occasionally when it " +
      "fits, never as a verbal tic. " +
      "For every caller utterance that needs an answer, call jarvis_turn exactly once with its " +
      "faithful transcription. Do not answer the caller yourself before that function returns. " +
      "After it returns, speak the reply faithfully in the same butler persona. Never infer that " +
      "a call should end; the delegated Jarvis response controls that safely."
    );
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

  private async configureSession(): Promise<void> {
    const configured = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.sessionConfiguration = undefined;
        reject(new Error("OpenAI Realtime did not confirm the audio session"));
      }, 10_000);
      this.sessionConfiguration = { resolve, reject, timeout };
    });
    this.send({
      type: "session.update",
      event_id: "jarvis-session-config",
      session: {
        type: "realtime",
        // Realtime 2.x accepts a single output mode. Audio responses include
        // their transcript automatically; requesting text and audio together
        // is not valid in the current schema.
        output_modalities: ["audio"],
        instructions: this.voiceInstructions(),
        // The current Realtime schema nests both the voice and formats under
        // audio.output/audio.input. The former top-level fields are silently
        // ignored by newer sessions, which leaves OpenAI's default voice on.
        audio: {
          input: {
            format: { type: "audio/pcm", rate: OPENAI_SAMPLE_RATE },
            transcription: { model: "gpt-4o-mini-transcribe", language: "de" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.45,
              prefix_padding_ms: 300,
              silence_duration_ms: 650,
              create_response: true,
              interrupt_response: true,
              idle_timeout_ms: this.options.idleHangupMs,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: OPENAI_SAMPLE_RATE },
            voice: this.options.voice,
            speed: 1.15,
          },
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
    await configured;
  }

  private requestGreeting(): void {
    this.send({
      type: "response.create",
      response: {
        tool_choice: "none",
        conversation: "none",
        instructions:
          "Output exactly the following German sentence, character for character. Do not translate " +
          "it, paraphrase it, add a greeting or generic question, or call a tool: " +
          JSON.stringify(this.options.greeting),
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
      case "session.updated": {
        const effectiveVoice = event.session?.audio?.output?.voice ?? event.session?.voice;
        const pending = this.sessionConfiguration;
        if (pending) {
          clearTimeout(pending.timeout);
          this.sessionConfiguration = undefined;
          pending.resolve();
        }
        this.logger.info(
          { callId: this.transport.callId, requestedVoice: this.options.voice, effectiveVoice },
          "OpenAI Realtime session configured",
        );
        return;
      }
      case "response.created":
        this.responseActive = true;
        return;
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (event.delta) this.queueRemoteAudio(Buffer.from(event.delta, "base64"));
        return;
      case "input_audio_buffer.speech_started":
        this.lastActivity = Date.now();
        this.interruptPlayback();
        return;
      case "conversation.item.input_audio_transcription.completed":
        // `info`, not `debug`. LOG_LEVEL is `info` in every deployment, so at
        // debug this was never actually visible — and what the other party said
        // is the single most useful line when working out why a call went the
        // way it did.
        if (event.transcript?.trim()) {
          this.logger.info(
            { callId: this.transport.callId, said: event.transcript.trim() },
            "call: other party said",
          );
        }
        return;
      // What Jarvis actually spoke, as the model transcribes its own audio.
      // Both spellings are handled for the same reason the audio deltas are:
      // the GA event was renamed and older deployments still emit the old one.
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (event.transcript?.trim()) {
          this.logger.info(
            { callId: this.transport.callId, said: event.transcript.trim() },
            "call: Jarvis said",
          );
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
        this.responseActive = false;
        void this.finishResponse();
        return;
      case "error":
        if (this.sessionConfiguration) {
          const pending = this.sessionConfiguration;
          clearTimeout(pending.timeout);
          this.sessionConfiguration = undefined;
          pending.reject(new Error(event.error?.message ?? "OpenAI Realtime rejected session configuration"));
        }
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
        const spokenByCaller = text;
        const outboundContext = this.outboundContextPending;
        this.outboundContextPending = undefined;
        const thirdPartyCallId = this.options.thirdPartyCallId;
        // Labelling a stranger's words "Aussage von Master" is how a hairdresser
        // ended up being addressed as the owner.
        const speaker = thirdPartyCallId
          ? "Aussage des Gesprächspartners"
          : "Aktuelle Aussage von Master";
        const framed = outboundContext
          ? `Ausgehender Anruf – interner Arbeitskontext: ${outboundContext}\n\n${speaker}: ${text}`
          : text;
        // A stranger's turn goes to the call-scoped route. The inbound path
        // asks the identity allowlist whether the speaker may talk to Jarvis,
        // which the far end of an outbound call can never satisfy — it answered
        // every third-party utterance with a 403.
        const reply = thirdPartyCallId
          ? await this.orchestrator.sendCallTurn({
              callId: thirdPartyCallId,
              text: framed,
              ...(this.conversationId ? { conversationId: this.conversationId } : {}),
            })
          : await this.orchestrator.send({
              channelUserId: this.channelUserId,
              text: framed,
              ...(this.conversationId ? { conversationId: this.conversationId } : {}),
            });
        this.conversationId = reply.conversationId;
        this.turns += 1;
        this.lastActivity = Date.now();
        if (reply.endCall) this.pendingEndCall = reply.endCall;
        output = { reply: reply.reply, ...(reply.endCall ? { endCall: true } : {}) };
        this.logger.info(
          {
            callId: this.transport.callId,
            turn: this.turns,
            heard: spokenByCaller,
            // What the orchestrator told it to say. Without this the log shows
            // that a turn happened but not what came of it, which is exactly
            // what you need when a call goes somewhere unexpected.
            replied: reply.reply,
            orchestratorMs: Date.now() - started,
          },
          "realtime turn delegated",
        );
      } catch (err) {
        const message = String(err);
        // A rejected identity is not a malfunction, it is the identity gate
        // doing its job — and on an OUTBOUND call to a third party it fires by
        // definition, because the callee is not a registered user. Called out
        // separately so it stops reading like a random failure.
        // The orchestrator answers a rejected identity with a bare 403, so the
        // status is the only thing that reaches here — matching on the wording
        // alone never fired.
        const unregistered = /\b403\b|unregistered|identity/i.test(message);
        this.logger.error(
          {
            callId: this.transport.callId,
            channelUserId: this.channelUserId,
            err: message,
            ...(unregistered
              ? {
                  hint:
                    "the far end is not a registered identity; an outbound call to a third " +
                    "party cannot be delegated through the owner's inbound path",
                }
              : {}),
          },
          "realtime delegation failed",
        );
        // On a call to a stranger, improvising onward is worse than stopping:
        // the previous behaviour produced four turns of an assistant chatting
        // to a hairdresser about what its owner might need next. Apologise once
        // and let the call end.
        output = this.options.thirdPartyCallId
          ? {
              reply:
                "Entschuldigung, bei mir ist gerade ein technisches Problem aufgetreten. " +
                "Ich melde mich noch einmal. Auf Wiederhören.",
              endCall: true,
            }
          : { reply: "Entschuldigung, da ist bei mir gerade etwas schiefgelaufen." };
        if (this.options.thirdPartyCallId) {
          this.pendingEndCall = { reason: "delegation failed on a third-party call" };
        }
      }
    }

    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
    });
    this.send({
      type: "response.create",
      response: {
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
    // Do not cut the opening statement short. Everything the callee says while
    // it plays is still transcribed and delegated afterwards, so nothing is
    // lost — it just does not talk over itself.
    if (this.openingStatementPending) return;
    this.playbackGeneration += 1;
    this.remoteAudio = Buffer.alloc(0);
    this.transport.stopSending();
    if (!this.responseActive) return;
    this.responseActive = false;
    this.send({ type: "response.cancel" });
  }

  private async finishResponse(): Promise<void> {
    await this.playback;
    await this.transport.flush();
    // The opening has now been heard in full, so normal barge-in applies from
    // here on: from this point an interruption really is one.
    this.openingStatementPending = false;
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
