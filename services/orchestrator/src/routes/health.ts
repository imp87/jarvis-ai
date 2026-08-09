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
      const [tools, policy] = await Promise.all([
        container.tools.list(),
        // Resolved, not the environment values — otherwise the overview would
        // report a quiet-hours window that is no longer the one being enforced.
        container.policy.resolve(),
      ]);
      res.json({
        profiles: container.router.listProfiles(),
        mcpServers: container.mcp.listServers(),
        tools: tools.map((t) => ({
          name: t.name,
          source: t.source,
          sideEffects: t.sideEffects,
        })),
        policy: {
          quietHours: policy.quietHours,
          maxCallsPerHour: policy.maxCallsPerHour,
          maxCallsPerDay: policy.maxCallsPerDay,
          // Still environment-only: this bounds a single turn's cost, which is
          // a deployment concern rather than something to tune from a phone.
          maxAgentSteps: container.config.env.MAX_AGENT_STEPS,
          overridden: policy.overridden,
        },
        callBudgetUsage: await container.repos.calls.budgetUsage(),
      });
    }),
  );

  return router;
}
