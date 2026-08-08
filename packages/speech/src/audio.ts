import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import { SpeechError, type AudioClip, type AudioEncoding } from "./types.js";

/**
 * Audio conversion via a statically bundled ffmpeg. This is why the speech
 * package needs no system install: `ffmpeg-static` ships the binary through npm.
 */
const FFMPEG = (ffmpegStatic as unknown as string | null) ?? "ffmpeg";

interface FormatSpec {
  /** ffmpeg output format (-f). */
  format: string;
  codec?: string;
  extraArgs?: string[];
}

const OUTPUT_SPECS: Record<AudioEncoding, FormatSpec> = {
  // libopus in Ogg: what Telegram expects for a real voice note. Sending an
  // mp3 as a "voice" message makes Telegram render it as a file attachment.
  ogg_opus: { format: "ogg", codec: "libopus", extraArgs: ["-b:a", "32k"] },
  mp3: { format: "mp3", codec: "libmp3lame" },
  wav_pcm16: { format: "wav", codec: "pcm_s16le" },
  raw_pcm16: { format: "s16le", codec: "pcm_s16le" },
};

export interface ConvertTarget {
  encoding: AudioEncoding;
  sampleRate?: number;
  channels?: number;
}

export async function convertAudio(
  clip: AudioClip,
  target: ConvertTarget,
): Promise<AudioClip> {
  const sampleRate = target.sampleRate ?? defaultSampleRate(target.encoding);
  const channels = target.channels ?? 1;

  // Already correct? Converting anyway would only lose quality.
  if (
    clip.encoding === target.encoding &&
    (clip.sampleRate === undefined || clip.sampleRate === sampleRate) &&
    (clip.channels === undefined || clip.channels === channels)
  ) {
    return clip;
  }

  const spec = OUTPUT_SPECS[target.encoding];
  const args: string[] = ["-hide_banner", "-loglevel", "error"];

  // Headerless input carries no format information, so describe it explicitly.
  if (clip.encoding === "raw_pcm16") {
    args.push("-f", "s16le", "-ar", String(clip.sampleRate ?? 16_000), "-ac", String(clip.channels ?? 1));
  }
  args.push("-i", "pipe:0", "-ar", String(sampleRate), "-ac", String(channels));
  if (spec.codec) args.push("-acodec", spec.codec);
  if (spec.extraArgs) args.push(...spec.extraArgs);
  args.push("-f", spec.format, "pipe:1");

  const data = await runFfmpeg(args, clip.data);
  return { data, encoding: target.encoding, sampleRate, channels };
}

function defaultSampleRate(encoding: AudioEncoding): number {
  // Opus only supports a fixed set of rates and normalises to 48 kHz anyway.
  // Whisper wants 16 kHz, which is also what the SIP side will use.
  return encoding === "ogg_opus" ? 48_000 : 16_000;
}

function runFfmpeg(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (err) =>
      reject(new SpeechError(`ffmpeg could not be started: ${err.message}`, "ffmpeg", { cause: err })),
    );
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      reject(
        new SpeechError(
          `ffmpeg exited with ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 500)}`,
          "ffmpeg",
        ),
      );
    });

    // EPIPE is normal when ffmpeg rejects the input and exits before reading it
    // all; the close handler reports the real error.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/**
 * Decode a 16-bit PCM WAV into the normalised Float32 samples the local Whisper
 * model expects. Written by hand to avoid pulling in an audio library for what
 * is a header walk and a division.
 */
export function wavToFloat32(wav: Buffer): { samples: Float32Array; sampleRate: number } {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new SpeechError("not a RIFF/WAVE buffer", "audio");
  }

  let offset = 12;
  let sampleRate = 16_000;
  let bitsPerSample = 16;
  let channels = 1;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (chunkId === "fmt ") {
      channels = wav.readUInt16LE(body + 2);
      sampleRate = wav.readUInt32LE(body + 4);
      bitsPerSample = wav.readUInt16LE(body + 14);
    } else if (chunkId === "data") {
      dataStart = body;
      dataLength = Math.min(chunkSize, wav.length - body);
      break;
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (dataStart < 0) throw new SpeechError("WAV buffer has no data chunk", "audio");
  if (bitsPerSample !== 16) {
    throw new SpeechError(`expected 16-bit PCM, got ${bitsPerSample}-bit`, "audio");
  }

  const frameCount = Math.floor(dataLength / 2 / channels);
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    // Downmix by taking the first channel; the callers all request mono anyway.
    const sample = wav.readInt16LE(dataStart + i * 2 * channels);
    samples[i] = sample / 32_768;
  }
  return { samples, sampleRate };
}
