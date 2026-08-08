import type { Logger } from "@jarvis/shared";
import type { UpdateHandler } from "./handler.js";
import type { TelegramClient } from "./telegram.js";

/**
 * Long-polling loop. Development only — the production path is the webhook.
 * It exists so the adapter can be verified end to end against a real bot before
 * DynDNS, the port forward and the certificate are in place.
 *
 * Telegram refuses getUpdates while a webhook is registered, so the caller must
 * deleteWebhook first.
 */
export class PollingLoop {
  private running = false;
  private offset = 0;

  constructor(
    private readonly telegram: TelegramClient,
    private readonly handler: UpdateHandler,
    private readonly logger: Logger,
    private readonly timeoutSeconds = 30,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    this.logger.info("long-polling started (development mode)");
    let backoffMs = 1000;

    while (this.running) {
      try {
        const updates = await this.telegram.getUpdates(this.offset, this.timeoutSeconds);
        backoffMs = 1000;

        for (const update of updates) {
          // Advance the offset before handling: a failing update must not be
          // redelivered forever, and the handler reports its own errors.
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handler.handle(update);
        }
      } catch (err) {
        if (!this.running) break;
        this.logger.error({ err: String(err), retryInMs: backoffMs }, "polling error");
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
    this.logger.info("long-polling stopped");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
