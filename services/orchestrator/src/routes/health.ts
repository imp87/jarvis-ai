import { Router } from "express";
import type { Container } from "../container.js";
import { asyncHandler } from "../middleware/auth.js";

/**
 * `/health` is unauthenticated on purpose so a container orchestrator can probe
 * it, and returns nothing an attacker could use. `/v1/status` is behind auth
 * and is where the useful detail lives.
 */
export function healthRoutes(container: Container): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get(
    "/health/ready",
    asyncHandler(async (_req, res) => {
      try {
        await container.pool.query("SELECT 1");
        res.json({ status: "ready" });
      } catch {
        res.status(503).json({ status: "not_ready" });
      }
    }),
  );

  return router;
}

export function statusRoutes(container: Container): Router {
  const router = Router();

  router.get(
    "/v1/status",
    asyncHandler(async (_req, res) => {
      const tools = await container.tools.list();
      res.json({
        profiles: container.router.listProfiles(),
        mcpServers: container.mcp.listServers(),
        tools: tools.map((t) => ({
          name: t.name,
          source: t.source,
          sideEffects: t.sideEffects,
        })),
        policy: {
          quietHours: {
            start: container.config.env.QUIET_HOURS_START,
            end: container.config.env.QUIET_HOURS_END,
            timezone: container.config.env.QUIET_HOURS_TIMEZONE,
          },
          maxCallsPerHour: container.config.env.MAX_CALLS_PER_HOUR,
          maxCallsPerDay: container.config.env.MAX_CALLS_PER_DAY,
          maxAgentSteps: container.config.env.MAX_AGENT_STEPS,
        },
        callBudgetUsage: await container.repos.calls.budgetUsage(),
      });
    }),
  );

  return router;
}
