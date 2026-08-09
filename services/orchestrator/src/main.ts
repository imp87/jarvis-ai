import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
// Repo-root .env in development; in Docker the environment is injected directly
// and this file simply won't exist.
loadDotenv({ path: path.resolve(here, "../../../.env") });

const { loadConfig } = await import("./config.js");
const { buildContainer } = await import("./container.js");
const { createApp } = await import("./app.js");

const config = loadConfig();
const container = await buildContainer(config);
const app = createApp(container);

const server = app.listen(config.env.ORCHESTRATOR_PORT, () => {
  container.logger.info(
    {
      port: config.env.ORCHESTRATOR_PORT,
      profiles: container.router.listProfiles(),
      mcpServers: container.mcp.listServers(),
    },
    "orchestrator listening",
  );
  // Started only once the port is open: a task that phones someone should not
  // fire while the process might still fail to come up.
  container.taskRunner.start();
  container.mailDelivery.start();
  void container.imap.start();
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  container.logger.info({ signal }, "shutting down");

  // Stop accepting connections, then let in-flight requests finish before
  // tearing down the pool — killing the pool first turns a graceful restart
  // into a burst of 500s.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await container.shutdown();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  container.logger.fatal({ reason: String(reason) }, "unhandled rejection");
  process.exit(1);
});
