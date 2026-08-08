import path from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "@jarvis/shared";
import { convertAudio, wavToFloat32 } from "../audio.js";
import {
  SpeechError,
  type AudioClip,
  type SttProvider,
  type TranscriptionOptions,
  type TranscriptionResult,
} from "../types.js";

const PROVIDER = "whisper-local";
/** Whisper is trained on 16 kHz mono; anything else must be resampled first. */
const TARGET_SAMPLE_RATE = 16_000;

export interface WhisperLocalOptions {
  /**
   * Hugging Face model id. `Xenova/whisper-base` is the multilingual base model
   * — German is usable. `Xenova/whisper-small` is noticeably better on German
   * and roughly three times slower on CPU.
   */
  model?: string;
  /** Where model weights are cached. Defaults to the transformers.js cache. */
  cacheDir?: string;
  /** "fp32" is the safe default on CPU; "q8" halves memory at some accuracy cost. */
  dtype?: "fp32" | "fp16" | "q8" | "q4";
  logger?: Logger;
}

/**
 * Local speech-to-text, in-process. Runs Whisper through transformers.js on
 * onnxruntime — so it installs with `pnpm install` and needs no system binary,
 * unlike a whisper.cpp build. Nothing leaves the machine.
 *
 * The model is loaded lazily on first use and kept: loading costs seconds, and
 * paying that per voice note would be absurd.
 */
export class WhisperLocalStt implements SttProvider {
  readonly name = PROVIDER;

  private pipelinePromise: Promise<unknown> | undefined;
  private readonly model: string;
  /** Always writable. Configure it for persistence; the default only survives a reboot. */
  private readonly cacheDir: string;

  constructor(private readonly options: WhisperLocalOptions = {}) {
    this.model = options.model ?? "Xenova/whisper-base";
    this.cacheDir = options.cacheDir ?? path.join(tmpdir(), "jarvis-whisper");
  }

  /** Load the model ahead of the first request, e.g. at service startup. */
  async warmup(): Promise<void> {
    await this.getPipeline();
  }

  private async getPipeline(): Promise<
    (input: Float32Array, opts: Record<string, unknown>) => Promise<{ text?: string }>
  > {
    if (!this.pipelinePromise) {
      this.options.logger?.info({ model: this.model }, "loading local Whisper model (first use)");
      // Imported lazily so a deployment that only uses cloud speech never pays
      // the onnxruntime load cost.
      const cacheDir = this.cacheDir;
      this.pipelinePromise = import("@huggingface/transformers").then((mod) => {
        // Without an explicit cache directory the library writes inside its own
        // package, which no container running as a non-root user can do — and
        // that failure is fatal, not cosmetic. A writable default is therefore
        // part of the provider rather than something each caller must remember;
        // forgetting it once already cost a crash loop.
        const env = mod.env as { useBrowserCache?: boolean; cacheDir?: string };
        env.useBrowserCache = false;
        // Some internal paths read env.cacheDir rather than the per-call option.
        env.cacheDir = cacheDir;
        return mod.pipeline("automatic-speech-recognition", this.model, {
          ...(this.options.dtype ? { dtype: this.options.dtype } : {}),
          cache_dir: cacheDir,
        });
      });
    }
    return (await this.pipelinePromise) as (
      input: Float32Array,
      opts: Record<string, unknown>,
    ) => Promise<{ text?: string }>;
  }

  async transcribe(
    clip: AudioClip,
    options: TranscriptionOptions = {},
  ): Promise<TranscriptionResult> {
    const wav = await convertAudio(clip, {
      encoding: "wav_pcm16",
      sampleRate: TARGET_SAMPLE_RATE,
      channels: 1,
    });
    const { samples } = wavToFloat32(wav.data);
    if (samples.length === 0) {
      throw new SpeechError("audio contained no samples", PROVIDER);
    }

    const transcriber = await this.getPipeline();
    try {
      const output = await transcriber(samples, {
        // Whisper's own chunking; voice notes are short but this keeps a
        // three-minute ramble from blowing up the 30-second window.
        chunk_length_s: 30,
        stride_length_s: 5,
        ...(options.language ? { language: options.language } : {}),
        task: "transcribe",
      });
      return {
        text: (output.text ?? "").trim(),
        ...(options.language ? { language: options.language } : {}),
        durationSeconds: samples.length / TARGET_SAMPLE_RATE,
        provider: PROVIDER,
      };
    } catch (err) {
      throw new SpeechError(
        `local transcription failed: ${(err as Error).message}`,
        PROVIDER,
        { cause: err },
      );
    }
  }
}
