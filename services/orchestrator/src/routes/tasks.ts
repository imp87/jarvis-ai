import { Router } from "express";
import { z } from "zod";
import { NotFoundError, channelNameSchema } from "@jarvis/shared";
import type { Container } from "../container.js";
import { asyncHandler } from "../middleware/auth.js";
import { MIN_INTERVAL_SECONDS, describeSchedule, nextRunAt } from "../services/schedule.js";

/**
 * Scheduled work (component 11). The admin UI is a client of these; the agent
 * reaches the same logic through its own tools rather than over HTTP.
 */

const scheduleSchema = z
  .object({
    scheduleKind: z.enum(["interval", "cron", "once"]),
    intervalSeconds: z.coerce.number().int().min(MIN_INTERVAL_SECONDS).nullable().optional(),
    cron: z.string().min(1).max(200).nullable().optional(),
    timezone: z.string().min(1).max(64).default("Europe/Berlin"),
    runAt: z.string().datetime().nullable().optional(),
  })
  .refine((v) => v.scheduleKind !== "interval" || Boolean(v.intervalSeconds), {
    message: "intervalSeconds is required for an interval schedule",
    path: ["intervalSeconds"],
  })
  .refine((v) => v.scheduleKind !== "cron" || Boolean(v.cron), {
    message: "cron is required for a cron schedule",
    path: ["cron"],
  })
  .refine((v) => v.scheduleKind !== "once" || Boolean(v.runAt), {
    message: "runAt is required for a one-off",
    path: ["runAt"],
  });

const createTaskSchema = scheduleSchema.and(
  z.object({
    userId: z.string().uuid(),
    title: z.string().min(1).max(200),
    kind: z.enum(["agent", "notify"]),
    prompt: z.string().min(1).max(8_000),
    channel: channelNameSchema.default("telegram"),
    profile: z.string().max(64).nullable().optional(),
  }),
);

export function taskRoutes(container: Container): Router {
  const router = Router();
  const { repos, taskService, taskRunner, logger } = container;

  const present = (task: Awaited<ReturnType<typeof repos.tasks.get>>) =>
    task && {
      ...task,
      scheduleDescription: describeSchedule({
        kind: task.scheduleKind,
        intervalSeconds: task.intervalSeconds,
        cron: task.cron,
        timezone: task.timezone,
      }),
    };

  router.get(
    "/v1/tasks",
    asyncHandler(async (req, res) => {
      const userId = req.query["userId"]
        ? z.string().uuid().parse(req.query["userId"])
        : undefined;
      const tasks = await repos.tasks.list(userId);
      res.json({ tasks: tasks.map((t) => present(t)) });
    }),
  );

  router.get(
    "/v1/tasks/:id/runs",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
      const limit = z.coerce.number().int().min(1).max(100).default(20).parse(req.query["limit"]);
      res.json({ runs: await repos.tasks.listRuns(id, limit) });
    }),
  );

  router.post(
    "/v1/tasks",
    asyncHandler(async (req, res) => {
      const input = createTaskSchema.parse(req.body);
      const task = await taskService.create({
        userId: input.userId,
        title: input.title,
        kind: input.kind,
        prompt: input.prompt,
        channel: input.channel,
        profile: input.profile ?? null,
        schedule: {
          kind: input.scheduleKind,
          intervalSeconds: input.intervalSeconds ?? null,
          cron: input.cron ?? null,
          timezone: input.timezone,
        },
        ...(input.runAt ? { runAt: new Date(input.runAt) } : {}),
        createdBy: "user",
      });
      logger.info({ taskId: task.id, title: task.title }, "task created");
      res.status(201).json({ task: present(task) });
    }),
  );

  router.patch(
    "/v1/tasks/:id",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
      const patch = z
        .object({
          title: z.string().min(1).max(200).optional(),
          prompt: z.string().min(1).max(8_000).optional(),
          enabled: z.boolean().optional(),
        })
        .parse(req.body);

      const existing = await repos.tasks.get(id);
      if (!existing) throw new NotFoundError("task not found");

      // Re-enabling a task whose next run is in the past — or gone — would
      // either fire immediately or never. Give it a fresh slot instead.
      const reviving = patch.enabled === true && !existing.enabled;
      const task = await repos.tasks.update(id, {
        ...patch,
        ...(reviving && existing.scheduleKind !== "once"
          ? {
              nextRunAt: nextRunAt(
                {
                  kind: existing.scheduleKind,
                  intervalSeconds: existing.intervalSeconds,
                  cron: existing.cron,
                  timezone: existing.timezone,
                },
                new Date(),
              ),
            }
          : {}),
      });
      res.json({ task: present(task) });
    }),
  );

  /** Runs a task immediately without touching its schedule. */
  router.post(
    "/v1/tasks/:id/run",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
      const task = await repos.tasks.get(id);
      if (!task) throw new NotFoundError("task not found");
      const outcome = await taskRunner.runNow(task);
      res.json(outcome);
    }),
  );

  router.delete(
    "/v1/tasks/:id",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
      if (!(await repos.tasks.delete(id))) throw new NotFoundError("task not found");
      res.status(204).end();
    }),
  );

  return router;
}
