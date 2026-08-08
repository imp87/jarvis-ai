import type { Logger } from "@jarvis/shared";
import type { UpdateHandler } from "./handler.js";
import type { TelegramClient } from "./telegram.js";

/**
 * Long-polling loop. A supported deployment mode, not a development fallback:
 * it needs no inbound reachability, which behind DS-Lite/CGNAT is often the
 * only option — Telegram delivers webhooks exclusively to ports 80, 88, 443 and
 * 8443, and ISP port ranges rarely include any of them.
 *
 * Latency is not the trade-off people expect: getUpdates returns the moment a
 * message arrives rather than waiting out the timeout. What you give up is
 * horizontal scaling (one poller per bot) and an always-open outbound request.
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
    this.logger.info({ timeoutSeconds: this.timeoutSeconds }, "long-polling started");
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
