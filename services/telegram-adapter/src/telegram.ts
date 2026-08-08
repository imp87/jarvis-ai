import { z } from "zod";

/**
 * Minimal Telegram Bot API client. Only the handful of methods this adapter
 * needs — a full SDK would be more surface than the whole service.
 */

export const telegramUserSchema = z.object({
  id: z.number(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  username: z.string().optional(),
});

export const telegramVoiceSchema = z.object({
  file_id: z.string(),
  file_unique_id: z.string().optional(),
  duration: z.number().optional(),
  mime_type: z.string().optional(),
  file_size: z.number().optional(),
});

export const telegramMessageSchema = z.object({
  message_id: z.number(),
  from: telegramUserSchema.optional(),
  chat: z.object({ id: z.number(), type: z.string().optional() }),
  date: z.number().optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  voice: telegramVoiceSchema.optional(),
  audio: telegramVoiceSchema.optional(),
});

export const telegramUpdateSchema = z
  .object({
    update_id: z.number(),
    message: telegramMessageSchema.optional(),
    edited_message: telegramMessageSchema.optional(),
  })
  // Telegram adds new update kinds over time; ignore what we don't handle
  // rather than rejecting the delivery and making Telegram retry forever.
  .passthrough();

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
export type TelegramMessage = z.infer<typeof telegramMessageSchema>;

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export class TelegramClient {
  private readonly apiBase: string;
  private readonly fileBase: string;

  constructor(
    private readonly token: string,
    private readonly timeoutMs = 30_000,
  ) {
    this.apiBase = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
  }

  private async call<T>(method: string, payload?: unknown, timeoutMs?: number): Promise<T> {
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    }).catch((err: unknown) => {
      throw new TelegramApiError(`${method} request failed: ${(err as Error).message}`, method);
    });

    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (!response.ok || body.ok !== true) {
      throw new TelegramApiError(
        `${method} failed: ${body.description ?? response.statusText}`,
        method,
        response.status,
      );
    }
    return body.result as T;
  }

  getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
    return this.call("getMe");
  }

  /**
   * Registering the webhook also sets the secret token Telegram will send back
   * in `X-Telegram-Bot-Api-Secret-Token` on every delivery.
   */
  setWebhook(input: {
    url: string;
    secretToken: string;
    allowedUpdates?: string[];
    dropPendingUpdates?: boolean;
    /** PEM-encoded public certificate, for a self-signed setup. */
    certificate?: string;
  }): Promise<boolean> {
    return this.call("setWebhook", {
      url: input.url,
      secret_token: input.secretToken,
      allowed_updates: input.allowedUpdates ?? ["message"],
      drop_pending_updates: input.dropPendingUpdates ?? false,
      ...(input.certificate ? { certificate: input.certificate } : {}),
    });
  }

  deleteWebhook(dropPendingUpdates = false): Promise<boolean> {
    return this.call("deleteWebhook", { drop_pending_updates: dropPendingUpdates });
  }

  getWebhookInfo(): Promise<{
    url?: string;
    has_custom_certificate?: boolean;
    pending_update_count?: number;
    last_error_message?: string;
  }> {
    return this.call("getWebhookInfo");
  }

  /** Long polling — development only; production uses the webhook. */
  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    const raw = await this.call<unknown[]>(
      "getUpdates",
      { offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
      // Outlive the long poll itself, or every poll aborts on the client side.
      (timeoutSeconds + 10) * 1000,
    );
    return raw.flatMap((item) => {
      const parsed = telegramUpdateSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  }

  sendMessage(chatId: number, text: string): Promise<TelegramMessage> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      // No parse_mode: model output is not guaranteed to be valid Markdown, and
      // Telegram rejects the whole message when it isn't.
      disable_web_page_preview: true,
    });
  }

  sendChatAction(chatId: number, action: "typing" | "record_voice" | "upload_voice"): Promise<boolean> {
    return this.call("sendChatAction", { chat_id: chatId, action });
  }

  async sendVoice(chatId: number, ogg: Buffer, caption?: string): Promise<TelegramMessage> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    // Must be OGG/Opus, or Telegram renders it as a file rather than a playable
    // voice note.
    form.append("voice", new Blob([new Uint8Array(ogg)], { type: "audio/ogg" }), "reply.ogg");
    if (caption) form.append("caption", caption.slice(0, 1024));

    const response = await fetch(`${this.apiBase}/sendVoice`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err: unknown) => {
      throw new TelegramApiError(`sendVoice request failed: ${(err as Error).message}`, "sendVoice");
    });

    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: TelegramMessage;
      description?: string;
    };
    if (!response.ok || body.ok !== true) {
      throw new TelegramApiError(
        `sendVoice failed: ${body.description ?? response.statusText}`,
        "sendVoice",
        response.status,
      );
    }
    return body.result!;
  }

  /** Two steps: resolve the file path, then download it from the file endpoint. */
  async downloadFile(fileId: string, maxBytes: number): Promise<Buffer> {
    const info = await this.call<{ file_path?: string; file_size?: number }>("getFile", {
      file_id: fileId,
    });
    if (!info.file_path) {
      throw new TelegramApiError("getFile returned no file_path", "getFile");
    }
    if (info.file_size !== undefined && info.file_size > maxBytes) {
      throw new TelegramApiError(
        `file is ${info.file_size} bytes, limit is ${maxBytes}`,
        "getFile",
      );
    }

    const response = await fetch(`${this.fileBase}/${info.file_path}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new TelegramApiError(`file download failed: ${response.status}`, "downloadFile");
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    // Re-check after the fact: file_size is advisory and absent often enough.
    if (buffer.byteLength > maxBytes) {
      throw new TelegramApiError(
        `downloaded ${buffer.byteLength} bytes, limit is ${maxBytes}`,
        "downloadFile",
      );
    }
    return buffer;
  }
}
