import type { Logger } from "@jarvis/shared";
import type { SpeechServices } from "@jarvis/speech";
import type { OrchestratorClient } from "./orchestrator.js";
import type { TelegramClient, TelegramMessage, TelegramUpdate } from "./telegram.js";

/** Telegram hard-caps a text message at 4096 characters. */
const MAX_TEXT_LENGTH = 4096;
/** Long replies are unpleasant as speech; send those as text regardless. */
const MAX_SPOKEN_CHARS = 1500;

export interface HandlerOptions {
  maxVoiceBytes: number;
}

export class UpdateHandler {
  constructor(
    private readonly telegram: TelegramClient,
    private readonly orchestrator: OrchestratorClient,
    private readonly speech: SpeechServices,
    private readonly logger: Logger,
    private readonly options: HandlerOptions,
  ) {}

  async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message ?? update.edited_message;
    if (!message) return;

    try {
      await this.handleMessage(message);
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.stack : String(err), updateId: update.update_id },
        "failed to handle update",
      );
      // Tell the user something went wrong. Silently swallowing the error looks
      // identical to the bot being offline.
      await this.telegram
        .sendMessage(message.chat.id, "Da ist bei mir etwas schiefgelaufen. Versuch es nochmal.")
        .catch(() => undefined);
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const from = message.from;
    if (!from || from.is_bot) return;

    const channelUserId = String(from.id);
    const log = this.logger.child({ channelUserId, chatId: message.chat.id });

    // Identity first, before anything expensive. An unregistered sender must not
    // be able to make us download and transcribe audio.
    const identity = await this.orchestrator.resolveIdentity(channelUserId);
    if (!identity) {
      log.warn("rejected message from unregistered telegram identity");
      await this.telegram.sendMessage(
        message.chat.id,
        `Dieser Bot ist privat und deine Telegram-ID (${channelUserId}) ist nicht freigeschaltet.`,
      );
      return;
    }

    const voice = message.voice ?? message.audio;
    let text: string;
    let wasVoiceInput = false;

    if (voice) {
      await this.telegram.sendChatAction(message.chat.id, "typing").catch(() => undefined);
      const audio = await this.telegram.downloadFile(voice.file_id, this.options.maxVoiceBytes);
      const started = Date.now();
      const transcription = await this.speech.stt.transcribe(
        { data: audio, encoding: "ogg_opus" },
        { language: identity.settings.language },
      );
      log.info(
        {
          provider: transcription.provider,
          bytes: audio.byteLength,
          audioSeconds: transcription.durationSeconds,
          transcribeMs: Date.now() - started,
        },
        "voice note transcribed",
      );

      if (transcription.text.length === 0) {
        await this.telegram.sendMessage(
          message.chat.id,
          "Ich konnte in der Sprachnachricht nichts verstehen.",
        );
        return;
      }
      text = transcription.text;
      wasVoiceInput = true;
    } else {
      text = (message.text ?? message.caption ?? "").trim();
      if (text.length === 0) {
        log.debug("ignoring message with no usable content");
        return;
      }
    }

    await this.telegram.sendChatAction(message.chat.id, "typing").catch(() => undefined);

    const result = await this.orchestrator.sendInbound({
      channelUserId,
      text,
      metadata: {
        chatId: message.chat.id,
        messageId: message.message_id,
        inputWasVoice: wasVoiceInput,
      },
    });

    await this.reply(message.chat.id, result, log);
  }

  private async reply(
    chatId: number,
    result: { reply: string; replyFormat: "text" | "voice"; voiceId: string | null; language: string },
    log: Logger,
  ): Promise<void> {
    const reply = result.reply.trim();
    if (reply.length === 0) return;

    // The stored setting decides the format — not what the user sent.
    const wantsVoice = result.replyFormat === "voice";
    if (!wantsVoice) {
      await this.sendText(chatId, reply);
      return;
    }

    if (reply.length > MAX_SPOKEN_CHARS) {
      log.info({ length: reply.length }, "reply too long to speak; sending as text");
      await this.sendText(chatId, reply);
      return;
    }

    try {
      await this.telegram.sendChatAction(chatId, "record_voice").catch(() => undefined);
      const started = Date.now();
      const clip = await this.speech.tts.synthesize(reply, {
        format: "ogg_opus",
        ...(result.voiceId ? { voice: result.voiceId } : {}),
        language: result.language,
      });
      log.info(
        { provider: this.speech.tts.name, bytes: clip.data.byteLength, synthMs: Date.now() - started },
        "reply synthesised",
      );
      await this.telegram.sendVoice(chatId, clip.data);
    } catch (err) {
      // A broken TTS must not swallow the answer — fall back to text and say so.
      log.error({ err: String(err) }, "speech synthesis failed; falling back to text");
      await this.sendText(chatId, reply);
    }
  }

  /** Telegram rejects anything over 4096 characters, so split on that boundary. */
  private async sendText(chatId: number, text: string): Promise<void> {
    for (let offset = 0; offset < text.length; offset += MAX_TEXT_LENGTH) {
      await this.telegram.sendMessage(chatId, text.slice(offset, offset + MAX_TEXT_LENGTH));
    }
  }
}
