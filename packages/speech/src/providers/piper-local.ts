import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { convertAudio } from "../audio.js";
import {
  SpeechError,
  type AudioClip,
  type SynthesisOptions,
  type TtsProvider,
} from "../types.js";

const PROVIDER = "piper-local";

export interface PiperOptions {
  /** Path to the piper executable. */
  binaryPath: string;
  /** Default voice model (.onnx). Its .onnx.json must sit next to it. */
  modelPath: string;
  /**
   * Directory holding additional voice models, so a per-user `voice` setting can
   * name one (e.g. "de_DE-thorsten-medium"). Omit to allow only the default.
   */
  voicesDir?: string;
  /**
   * Output rate of the voice model. Piper writes headerless PCM at the model's
   * native rate and does not report it, so it must be configured. The
   * de_DE-thorsten voices are 22050 Hz.
   */
  modelSampleRate?: number;
  timeoutMs?: number;
}

/**
 * Local text-to-speech via Piper. Unlike the STT side this needs a real binary
 * plus a voice model: Piper is the only local engine with genuinely good German
 * voices (de_DE-thorsten), and the pure-npm alternatives are English-only.
 *
 * Setup is two downloads — see docs/telegram-setup.md. The same binary will
 * serve the phone pipeline later, which is why this lives in `@jarvis/speech`
 * rather than in the Telegram adapter.
 */
export class PiperTts implements TtsProvider {
  readonly name = PROVIDER;

  private readonly modelSampleRate: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: PiperOptions) {
    this.modelSampleRate = options.modelSampleRate ?? 22_050;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /**
   * Verify the binary and default model exist. Call at startup: discovering a
   * missing voice model when the first voice note arrives is a bad trade.
   */
  async check(): Promise<void> {
    for (const [label, target] of [
      ["piper binary", this.options.binaryPath],
      ["piper voice model", this.options.modelPath],
    ] as const) {
      try {
        await access(target);
      } catch {
        throw new SpeechError(`${label} not found at ${target}`, PROVIDER);
      }
    }
  }

  /**
   * Resolve a requested voice to a model file. Voice names are restricted to a
   * safe character set and joined against `voicesDir`, so a stored setting can
   * never point at an arbitrary path.
   */
  private resolveModel(voice: string | undefined): string {
    if (!voice) return this.options.modelPath;
    if (!this.options.voicesDir) {
      throw new SpeechError(
        `voice "${voice}" requested but no voicesDir is configured`,
        PROVIDER,
      );
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(voice)) {
      throw new SpeechError(`invalid voice name "${voice}"`, PROVIDER);
    }
    const file = voice.endsWith(".onnx") ? voice : `${voice}.onnx`;
    return path.join(this.options.voicesDir, file);
  }

  async synthesize(text: string, options: SynthesisOptions): Promise<AudioClip> {
    const trimmed = text.trim();
    if (trimmed.length === 0) throw new SpeechError("nothing to synthesise", PROVIDER);

    // Headerless PCM on stdout: no temp file, no WAV header to strip.
    const args = ["--model", this.resolveModel(options.voice), "--output_raw"];
    const raw = await this.run(args, trimmed);
    if (raw.length === 0) throw new SpeechError("piper produced no audio", PROVIDER);

    return convertAudio(
      { data: raw, encoding: "raw_pcm16", sampleRate: this.modelSampleRate, channels: 1 },
      {
        encoding: options.format,
        ...(options.sampleRate !== undefined ? { sampleRate: options.sampleRate } : {}),
      },
    );
  }

  private run(args: string[], text: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.binaryPath, args, { stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new SpeechError(`piper timed out after ${this.timeoutMs}ms`, PROVIDER));
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(
          new SpeechError(`piper could not be started: ${err.message}`, PROVIDER, { cause: err }),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(Buffer.concat(stdout));
          return;
        }
        reject(
          new SpeechError(
            `piper exited with ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 500)}`,
            PROVIDER,
          ),
        );
      });

      child.stdin.on("error", () => undefined);
      child.stdin.end(text);
    });
  }
}
