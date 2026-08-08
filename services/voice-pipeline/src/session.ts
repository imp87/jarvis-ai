import { convertAudio, type SpeechServices } from "@jarvis/speech";
import { maskPhoneNumber, type Logger } from "@jarvis/shared";
import { Endpointer } from "./audio/endpointer.js";
import { FRAME_BYTES, TELEPHONY_SAMPLE_RATE, toFrames, type CallTransport } from "./transport.js";
import type { OrchestratorClient } from "./orchestrator.js";

export interface SessionOptions {
  /** Spoken first when the agent places the call, or answers one. */
  greeting: string;
  /** Frames kept before speech is detected, so the first syllable is not clipped. */
  prerollFrames?: number;
  language?: string;
  voice?: string | undefined;
  /** Ends the call after this much silence with nothing said. */
  idleHangupMs?: number;
}

export interface SessionResult {
  turns: number;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  endedBecause: "hangup" | "idle" | "error";
}

/**
 * The conversation engine: audio in, audio out, one turn at a time.
 *
 * Half-duplex on purpose for now. While the agent is speaking, incoming audio is
 * dropped rather than buffered — full barge-in needs the endpointer to run
 * *against* the outgoing stream and cancel playback mid-frame, and doing that
 * before the basic path is proven would mean debugging turn-taking and SIP
 * registration at the same time. `stopSending()` on the transport is the hook
 * it will use.
 */
export class CallSession {
  private readonly endpointer: Endpointer;
  private readonly captured: Buffer[] = [];
  private readonly preroll: Buffer[] = [];
  private readonly transcript: SessionResult["transcript"] = [];

  private speaking = false;
  private processing = false;
  private finished = false;
  private turns = 0;
  private conversationId: string | undefined;
  private lastActivity = Date.now();
  private endedBecause: SessionResult["endedBecause"] = "hangup";
  private resolveDone: ((result: SessionResult) => void) | undefined;

  constructor(
    private readonly transport: CallTransport,
    private readonly speech: SpeechServices,
    private readonly orchestrator: OrchestratorClient,
    /** The caller's normalised E.164 number — what the orchestrator keys on. */
    private readonly channelUserId: string,
    private readonly logger: Logger,
    private readonly options: SessionOptions,
  ) {
    this.endpointer = new Endpointer({ frameMs: 20, sampleRate: TELEPHONY_SAMPLE_RATE });
  }

  /**
   * True while the agent is speaking or thinking. In half-duplex mode incoming
   * audio is dropped during this window, so a caller talking over the agent is
   * not heard — the loopback harness waits on it, and it is the flag barge-in
   * will eventually make unnecessary.
   */
  get busy(): boolean {
    return this.speaking || this.processing;
  }

  async run(): Promise<SessionResult> {
    const done = new Promise<SessionResult>((resolve) => {
      this.resolveDone = resolve;
    });

    this.transport.onHangup(() => this.finish("hangup"));
    this.transport.onAudio((frame) => this.onFrame(frame));

    await this.say(this.options.greeting);

    const idleTimer = setInterval(() => {
      const idleFor = Date.now() - this.lastActivity;
      if (!this.speaking && !this.processing && idleFor > (this.options.idleHangupMs ?? 30_000)) {
        this.logger.info({ callId: this.transport.callId, idleFor }, "ending call after silence");
        void this.transport.hangup();
        this.finish("idle");
      }
    }, 1000);

    const result = await done;
    clearInterval(idleTimer);
    return result;
  }

  private finish(reason: SessionResult["endedBecause"]): void {
    if (this.finished) return;
    this.finished = true;
    this.endedBecause = reason;
    this.resolveDone?.({
      turns: this.turns,
      transcript: this.transcript,
      endedBecause: this.endedBecause,
    });
  }

  private onFrame(frame: Buffer): void {
    if (this.finished) return;
    // Half-duplex: our own speech must never be fed back into the recogniser.
    if (this.speaking || this.processing) return;

    const event = this.endpointer.push(frame);

    if (this.endpointer.speaking) {
      this.captured.push(frame);
    } else {
      // Keep a short rolling window so the syllables that triggered detection
      // are not lost — without this every utterance starts clipped.
      this.preroll.push(frame);
      if (this.preroll.length > (this.options.prerollFrames ?? 10)) this.preroll.shift();
    }

    if (event.type === "speech_start") {
      this.captured.unshift(...this.preroll.splice(0));
      this.lastActivity = Date.now();
      return;
    }

    if (event.type === "speech_end") {
      const audio = Buffer.concat(this.captured.splice(0));
      this.lastActivity = Date.now();
      void this.handleUtterance(audio, event.durationMs);
    }
  }

  private async handleUtterance(pcm: Buffer, durationMs: number): Promise<void> {
    if (this.processing || this.finished) return;
    this.processing = true;
    const started = Date.now();

    try {
      // Whisper needs a container and 16 kHz; the line gives us raw 8 kHz.
      const wav = await convertAudio(
        { data: pcm, encoding: "raw_pcm16", sampleRate: TELEPHONY_SAMPLE_RATE, channels: 1 },
        { encoding: "wav_pcm16", sampleRate: 16_000 },
      );
      const heard = await this.speech.stt.transcribe(wav, {
        ...(this.options.language ? { language: this.options.language } : {}),
      });
      const sttMs = Date.now() - started;

      const text = heard.text.trim();
      if (text.length === 0) {
        this.logger.debug({ callId: this.transport.callId, durationMs }, "empty transcription");
        this.processing = false;
        return;
      }

      this.transcript.push({ role: "user", text });
      this.turns += 1;

      const llmStarted = Date.now();
      const reply = await this.orchestrator.send({
        channelUserId: this.channelUserId,
        text,
        ...(this.conversationId ? { conversationId: this.conversationId } : {}),
      });
      this.conversationId = reply.conversationId;
      const llmMs = Date.now() - llmStarted;

      this.transcript.push({ role: "assistant", text: reply.reply });
      this.logger.info(
        {
          callId: this.transport.callId,
          turn: this.turns,
          audioMs: durationMs,
          sttMs,
          llmMs,
          heard: text,
        },
        "turn processed",
      );

      this.processing = false;
      await this.say(reply.reply);
    } catch (err) {
      this.logger.error(
        { callId: this.transport.callId, err: String(err) },
        "turn failed",
      );
      this.processing = false;
      // Say something rather than leaving dead air — silence on a phone call is
      // indistinguishable from a dropped connection.
      await this.say("Entschuldigung, da ist bei mir gerade etwas schiefgelaufen.").catch(
        () => undefined,
      );
    }
  }

  private async say(text: string): Promise<void> {
    if (this.finished || text.trim().length === 0) return;
    this.speaking = true;
    const started = Date.now();
    try {
      const clip = await this.speech.tts.synthesize(text, {
        format: "raw_pcm16",
        sampleRate: TELEPHONY_SAMPLE_RATE,
        ...(this.options.voice ? { voice: this.options.voice } : {}),
        ...(this.options.language ? { language: this.options.language } : {}),
      });
      this.logger.debug(
        { callId: this.transport.callId, ttsMs: Date.now() - started, bytes: clip.data.length },
        "reply synthesised",
      );
      for (const frame of toFrames(clip.data, FRAME_BYTES)) {
        if (this.finished) break;
        await this.transport.send(frame);
      }
    } finally {
      this.speaking = false;
      this.endpointer.reset();
      this.captured.length = 0;
      this.preroll.length = 0;
      this.lastActivity = Date.now();
    }
  }

  describe(): string {
    return `call ${this.transport.callId} ${this.transport.direction} ${
      this.transport.remoteNumber ? maskPhoneNumber(this.transport.remoteNumber) : "unknown"
    }`;
  }
}
