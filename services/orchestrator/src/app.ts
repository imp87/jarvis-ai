import express, { type Express } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { NotFoundError } from "@jarvis/shared";
import type { Container } from "./container.js";
import { errorHandler } from "./middleware/error.js";
import { requireServiceToken } from "./middleware/auth.js";
import { healthRoutes, statusRoutes } from "./routes/health.js";
import { messageRoutes } from "./routes/messages.js";
import { registryRoutes } from "./routes/registry.js";
import { adminRoutes } from "./routes/admin.js";
import { taskRoutes } from "./routes/tasks.js";
import { imapRoutes } from "./routes/imap.js";
import { caldavRoutes } from "./routes/caldav.js";

export function createApp(container: Container): Express {
  const app = express();
  const { env } = container.config;

  app.disable("x-powered-by");
  app.use(helmet());
  // 1 MB is generous for a chat message and small enough that a runaway adapter
  // can't exhaust memory.
  app.use(express.json({ limit: "1mb" }));

  // Trust the reverse proxy for client IPs so rate limiting keys on the real
  // caller rather than the proxy. `1` = exactly one hop (Nginx Proxy Manager).
  app.set("trust proxy", 1);

  app.use(healthRoutes(container));

  // Everything below requires the service token.
  const authed = express.Router();
  authed.use(requireServiceToken(env.SERVICE_TOKEN));
  authed.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  );
  authed.use(statusRoutes(container));
  authed.use(messageRoutes(container));
  authed.use(registryRoutes(container));
  authed.use(adminRoutes(container));
  authed.use(taskRoutes(container));
  authed.use(imapRoutes(container));
  authed.use(caldavRoutes(container));
  app.use(authed);

  app.use((req, _res, next) => {
    next(new NotFoundError(`no route for ${req.method} ${req.path}`));
  });
  app.use(errorHandler(container.logger));

  return app;
}
