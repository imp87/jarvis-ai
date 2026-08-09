/**
 * Speech interfaces, deliberately shaped like `@jarvis/llm`: one provider-neutral
 * contract, swappable adapters, selection in config.
 *
 * The audio *format* is part of the interface rather than an adapter detail,
 * because the consumers disagree about it and always will: Telegram wants
 * OGG/Opus voice notes, a SIP call wants raw 8 or 16 kHz PCM, a browser wants
 * MP3. Callers state what they need; adapters convert.
 */

export type AudioEncoding =
  /** Opus in an Ogg container — Telegram voice notes. */
  | "ogg_opus"
  | "mp3"
  /** 16-bit PCM with a WAV header. */
  | "wav_pcm16"
  /** Headerless 16-bit little-endian PCM — what SIP pipelines want. */
  | "raw_pcm16";

export interface AudioClip {
  data: Buffer;
  encoding: AudioEncoding;
  /** Required for raw_pcm16, since there is no header to carry it. */
  sampleRate?: number;
  channels?: number;
}

export interface TranscriptionOptions {
  /** ISO-639-1 hint. Omit to let the model detect it. */
  language?: string;
  /**
   * Optional vocabulary/context hint for an STT provider. It is not an
   * instruction to alter what was said: use it for product names and jargon
   * that the recogniser otherwise tends to spell incorrectly.
   */
  prompt?: string;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationSeconds?: number;
  provider: string;
}

export interface SttProvider {
  readonly name: string;
  transcribe(clip: AudioClip, options?: TranscriptionOptions): Promise<TranscriptionResult>;
}

export interface SynthesisOptions {
  format: AudioEncoding;
  /** Required when format is raw_pcm16. */
  sampleRate?: number;
  /** Provider-specific voice id. Omit for the provider default. */
  voice?: string;
  language?: string;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(text: string, options: SynthesisOptions): Promise<AudioClip>;
}

export interface SpeechServices {
  stt: SttProvider;
  tts: TtsProvider;
}

export class SpeechError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SpeechError";
  }
}
