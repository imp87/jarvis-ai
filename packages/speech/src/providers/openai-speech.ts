import { convertAudio } from "../audio.js";
import {
  SpeechError,
  type AudioClip,
  type AudioEncoding,
  type SttProvider,
  type SynthesisOptions,
  type TranscriptionOptions,
  type TranscriptionResult,
  type TtsProvider,
} from "../types.js";

const PROVIDER = "openai";

const MIME_BY_ENCODING: Record<AudioEncoding, { mime: string; ext: string }> = {
  ogg_opus: { mime: "audio/ogg", ext: "ogg" },
  mp3: { mime: "audio/mpeg", ext: "mp3" },
  wav_pcm16: { mime: "audio/wav", ext: "wav" },
  raw_pcm16: { mime: "audio/wav", ext: "wav" },
};

export interface OpenAiSpeechOptions {
  apiKey: string;
  baseUrl?: string;
  sttModel?: string;
  sttPrompt?: string;
  ttsModel?: string;
  defaultVoice?: string;
  timeoutMs?: number;
}

/**
 * Cloud fallback. Not the default — voice notes are sensitive and stay on the
 * machine unless someone deliberately switches this on in config. Useful when
 * the Mini-PC is too slow, or as a comparison baseline while tuning the local
 * models.
 */
export class OpenAiStt implements SttProvider {
  readonly name = PROVIDER;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAiSpeechOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.model = options.sttModel ?? "gpt-4o-mini-transcribe";
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async transcribe(
    clip: AudioClip,
    options: TranscriptionOptions = {},
  ): Promise<TranscriptionResult> {
    // Raw PCM has no container the API can parse; give it a WAV header.
    const payload =
      clip.encoding === "raw_pcm16"
        ? await convertAudio(clip, { encoding: "wav_pcm16", sampleRate: clip.sampleRate ?? 16_000 })
        : clip;
    const { mime, ext } = MIME_BY_ENCODING[payload.encoding];

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(payload.data)], { type: mime }), `audio.${ext}`);
    form.append("model", this.model);
    if (options.language) form.append("language", options.language);
    const prompt = options.prompt ?? this.options.sttPrompt;
    if (prompt) form.append("prompt", prompt);

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err: unknown) => {
      throw new SpeechError(`transcription request failed: ${(err as Error).message}`, PROVIDER, {
        cause: err,
      });
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new SpeechError(
        `transcription ${response.status}: ${text.slice(0, 400)}`,
        PROVIDER,
      );
    }

    const body = (await response.json()) as { text?: string; language?: string; duration?: number };
    return {
      text: (body.text ?? "").trim(),
      ...(body.language ?? options.language
        ? { language: body.language ?? options.language }
        : {}),
      ...(body.duration !== undefined ? { durationSeconds: body.duration } : {}),
      provider: PROVIDER,
    };
  }
}

export class OpenAiTts implements TtsProvider {
  readonly name = PROVIDER;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAiSpeechOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.model = options.ttsModel ?? "gpt-4o-mini-tts";
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async synthesize(text: string, options: SynthesisOptions): Promise<AudioClip> {
    const trimmed = text.trim();
    if (trimmed.length === 0) throw new SpeechError("nothing to synthesise", PROVIDER);

    // Ask for opus directly when that is the target — it saves a transcode.
    const wantsOpus = options.format === "ogg_opus";
    const responseFormat = wantsOpus ? "opus" : "wav";

    const response = await fetch(`${this.baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: trimmed,
        voice: options.voice ?? this.options.defaultVoice ?? "alloy",
        response_format: responseFormat,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err: unknown) => {
      throw new SpeechError(`speech request failed: ${(err as Error).message}`, PROVIDER, {
        cause: err,
      });
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new SpeechError(`speech ${response.status}: ${body.slice(0, 400)}`, PROVIDER);
    }

    const data = Buffer.from(await response.arrayBuffer());
    const clip: AudioClip = wantsOpus
      ? { data, encoding: "ogg_opus", sampleRate: 48_000, channels: 1 }
      : { data, encoding: "wav_pcm16" };

    return convertAudio(clip, {
      encoding: options.format,
      ...(options.sampleRate !== undefined ? { sampleRate: options.sampleRate } : {}),
    });
  }
}
