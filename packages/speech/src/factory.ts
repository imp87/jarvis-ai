import type { Logger } from "@jarvis/shared";
import { PiperTts, type PiperOptions } from "./providers/piper-local.js";
import { WhisperLocalStt, type WhisperLocalOptions } from "./providers/whisper-local.js";
import { OpenAiStt, OpenAiTts, type OpenAiSpeechOptions } from "./providers/openai-speech.js";
import type { SpeechServices, SttProvider, TtsProvider } from "./types.js";

export type SpeechEngine = "local" | "openai";

export interface SpeechConfig {
  /** Default is "local": voice notes are sensitive and stay on the machine. */
  stt: SpeechEngine;
  tts: SpeechEngine;
  whisper?: WhisperLocalOptions;
  piper?: PiperOptions;
  openai?: Omit<OpenAiSpeechOptions, "apiKey"> & { apiKey?: string | undefined };
  logger?: Logger;
}

export function buildSpeech(config: SpeechConfig): SpeechServices {
  return { stt: buildStt(config), tts: buildTts(config) };
}

export function buildStt(config: SpeechConfig): SttProvider {
  if (config.stt === "openai") {
    const apiKey = requireOpenAiKey(config, "STT");
    return new OpenAiStt({ ...config.openai, apiKey });
  }
  return new WhisperLocalStt({
    ...config.whisper,
    ...(config.logger ? { logger: config.logger } : {}),
  });
}

export function buildTts(config: SpeechConfig): TtsProvider {
  if (config.tts === "openai") {
    const apiKey = requireOpenAiKey(config, "TTS");
    return new OpenAiTts({ ...config.openai, apiKey });
  }
  if (!config.piper) {
    throw new Error(
      "local TTS selected but no piper configuration supplied — set PIPER_BINARY and PIPER_MODEL " +
        "(see docs/telegram-setup.md), or switch TTS_ENGINE to openai",
    );
  }
  return new PiperTts(config.piper);
}

function requireOpenAiKey(config: SpeechConfig, what: string): string {
  const apiKey = config.openai?.apiKey;
  if (!apiKey) throw new Error(`${what} engine is "openai" but OPENAI_API_KEY is not set`);
  return apiKey;
}
