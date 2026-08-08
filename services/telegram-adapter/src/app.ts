import express, { type Express } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import type { Logger } from "@jarvis/shared";
import type { Env } from "./config.js";
import type { UpdateHandler } from "./handler.js";
import { telegramUpdateSchema } from "./telegram.js";
import { requireTelegramSecret, requireTelegramSourceIp } from "./security.js";

export function createApp(
  env: Env,
  handler: UpdateHandler,
  logger: Logger,
): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  // Behind the local Nginx Proxy Manager, so trust exactly one hop for req.ip.
  app.set("trust proxy", 1);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", mode: env.TELEGRAM_MODE });
  });

  if (env.TELEGRAM_MODE === "webhook") {
    const secret = env.TELEGRAM_WEBHOOK_SECRET!;

    app.post(
      env.TELEGRAM_WEBHOOK_PATH,
      // Order matters: cheapest rejections first, and nothing parses a body
      // before the sender has been authenticated.
      requireTelegramSourceIp(env.TELEGRAM_IP_ALLOWLIST, logger),
      rateLimit({
        windowMs: 60_000,
        limit: 120,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        // A rate-limited delivery still gets 200 so Telegram does not retry it
        // into an even bigger backlog.
        handler: (_req, res) => res.status(200).json({ ok: true }),
      }),
      express.json({ limit: "1mb" }),
      requireTelegramSecret(secret, logger),
      (req, res) => {
        const parsed = telegramUpdateSchema.safeParse(req.body);
        if (!parsed.success) {
          logger.warn({ issues: parsed.error.issues }, "unparseable telegram update");
          // Still 200: a malformed update we cannot handle should be dropped,
          // not retried every minute for 24 hours.
          res.status(200).json({ ok: true });
          return;
        }

        // Acknowledge immediately and process in the background. Telegram
        // retries anything it does not get a prompt 200 for, and the agent loop
        // can take a minute — answering after it finishes causes duplicates.
        res.status(200).json({ ok: true });
        void handler.handle(parsed.data);
      },
    );
  }

  app.use((_req, res) => {
    res.status(404).json({ ok: false });
  });

  return app;
}
