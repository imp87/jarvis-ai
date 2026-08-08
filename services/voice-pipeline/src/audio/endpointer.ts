/**
 * Decides when the caller has stopped talking.
 *
 * This is the single most important piece of a phone agent's feel. Too eager and
 * it interrupts mid-sentence; too patient and every exchange gains a second of
 * dead air on top of the ~1.2 s the recogniser already costs.
 *
 * The approach is energy-based rather than a neural VAD: a phone line is 8 kHz
 * mono with predictable noise, and RMS over 20 ms frames separates speech from
 * silence well enough. A learned VAD (Silero via onnxruntime, which the speech
 * package already depends on) would handle noisy backgrounds better and is the
 * intended upgrade — but it should replace a working, measurable baseline
 * rather than be guessed at up front.
 *
 * Deliberately pure and synchronous: no timers, no I/O. The caller feeds frames
 * and reads decisions, which makes every threshold testable without audio
 * hardware.
 */

export interface EndpointerOptions {
  sampleRate?: number;
  /** Frame size in milliseconds. AudioSocket delivers 20 ms frames. */
  frameMs?: number;
  /**
   * RMS above which a frame counts as speech, in 0..1. Telephone speech sits
   * well above 0.02; line noise sits below 0.005.
   */
  speechThreshold?: number;
  /** Silence needed to close an utterance. Below ~500 ms it clips natural pauses. */
  silenceMs?: number;
  /** Speech needed before an utterance starts, to reject clicks and pops. */
  minSpeechMs?: number;
  /** Hard cap so a noisy line cannot buffer forever. */
  maxUtteranceMs?: number;
}

export type EndpointerEvent =
  | { type: "speech_start" }
  /** The utterance is complete; `reason` distinguishes a natural pause from the cap. */
  | { type: "speech_end"; durationMs: number; reason: "silence" | "max_duration" }
  | { type: "none" };

export class Endpointer {
  private readonly frameMs: number;
  private readonly speechThreshold: number;
  private readonly silenceFrames: number;
  private readonly minSpeechFrames: number;
  private readonly maxFrames: number;

  private inSpeech = false;
  private speechFrames = 0;
  private silenceRun = 0;
  /** Counts consecutive loud frames before an utterance is declared. */
  private leadingSpeechRun = 0;

  constructor(options: EndpointerOptions = {}) {
    this.frameMs = options.frameMs ?? 20;
    this.speechThreshold = options.speechThreshold ?? 0.02;
    this.silenceFrames = Math.max(1, Math.round((options.silenceMs ?? 700) / this.frameMs));
    this.minSpeechFrames = Math.max(1, Math.round((options.minSpeechMs ?? 120) / this.frameMs));
    this.maxFrames = Math.max(1, Math.round((options.maxUtteranceMs ?? 20_000) / this.frameMs));
  }

  /** Root-mean-square amplitude of a 16-bit little-endian PCM frame, in 0..1. */
  static rms(frame: Buffer): number {
    const samples = Math.floor(frame.length / 2);
    if (samples === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples; i += 1) {
      const value = frame.readInt16LE(i * 2) / 32_768;
      sum += value * value;
    }
    return Math.sqrt(sum / samples);
  }

  /** Feed one frame. Returns at most one event per frame. */
  push(frame: Buffer): EndpointerEvent {
    const loud = Endpointer.rms(frame) >= this.speechThreshold;

    if (!this.inSpeech) {
      // Require several consecutive loud frames so a keypad tone or a door
      // slamming does not open an utterance.
      this.leadingSpeechRun = loud ? this.leadingSpeechRun + 1 : 0;
      if (this.leadingSpeechRun >= this.minSpeechFrames) {
        this.inSpeech = true;
        this.speechFrames = this.leadingSpeechRun;
        this.silenceRun = 0;
        this.leadingSpeechRun = 0;
        return { type: "speech_start" };
      }
      return { type: "none" };
    }

    this.speechFrames += 1;
    this.silenceRun = loud ? 0 : this.silenceRun + 1;

    if (this.silenceRun >= this.silenceFrames) {
      // Report the utterance without its trailing silence.
      const durationMs = (this.speechFrames - this.silenceRun) * this.frameMs;
      this.reset();
      return { type: "speech_end", durationMs, reason: "silence" };
    }

    if (this.speechFrames >= this.maxFrames) {
      const durationMs = this.speechFrames * this.frameMs;
      this.reset();
      return { type: "speech_end", durationMs, reason: "max_duration" };
    }

    return { type: "none" };
  }

  get speaking(): boolean {
    return this.inSpeech;
  }

  reset(): void {
    this.inSpeech = false;
    this.speechFrames = 0;
    this.silenceRun = 0;
    this.leadingSpeechRun = 0;
  }
}
