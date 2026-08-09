import type { TaskRepository } from "@jarvis/db";
import type { ChannelName, ExecutableTool, ToolResult } from "@jarvis/shared";
import type { NotificationService } from "../../services/notify.js";
import type { TaskService } from "../../services/tasks.js";
import { describeSchedule } from "../../services/schedule.js";

/**
 * Scheduling and speaking first — the two things the agent could not do before.
 *
 * Both are deliberately narrow. Creating a task commits the system to spending
 * money on a schedule, and sending a message interrupts someone; neither is the
 * sort of capability to hand over with a vague description and hope.
 */
export function buildTaskTools(deps: {
  tasks: TaskRepository;
  taskService: TaskService;
  notifications: NotificationService;
}): ExecutableTool[] {
  const channels = deps.notifications.availableChannels();

  const tools: ExecutableTool[] = [
    {
      name: "task_create",
      description:
        "Schedule something to happen later, once or repeatedly — 'check my mail every 15 " +
        "minutes and call me if anything is urgent', 'every weekday at 8:00, summarise " +
        "today's calendar'.\n\n" +
        "The instruction runs later with no one watching, so write it as a complete standing " +
        "order: what to check, and what to do about each outcome including doing nothing. " +
        "'Check the mail' will produce a report every time; 'check the mail and only tell me " +
        "if something needs an answer today' will not.\n\n" +
        "Each task keeps its own conversation across runs, so you can see what you already " +
        "reported and need not repeat yourself.\n\n" +
        "For a one-off relative time such as 'in one hour', always use `delay_seconds` (3600 " +
        "for one hour). Never calculate an ISO timestamp yourself for a relative time. Use " +
        "`interval_seconds` only for 'every N minutes' and `cron` only for clock times " +
        "('0 8 * * 1-5'). Do not schedule anything faster than every 5 minutes. If a scheduled " +
        "task places a phone call, make its first spoken context state the concrete reminder in " +
        "German — never a generic 'What can I do for you?' greeting.",
      source: "builtin",
      // Commits to recurring spend and can reach the user unprompted.
      sideEffects: true,
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short label for the task list, e.g. 'Mail check'.",
          },
          instruction: {
            type: "string",
            description:
              "What to do on each run, written as a standing order including when to stay silent.",
          },
          interval_seconds: {
            type: "integer",
            minimum: 300,
            description: "Run every N seconds. Use this or cron, not both.",
          },
          cron: {
            type: "string",
            description:
              "Five-field cron expression for clock times, e.g. '0 8 * * 1-5'. Use this or interval_seconds.",
          },
          delay_seconds: {
            type: "integer",
            minimum: 60,
            description:
              "One-off delay from now in seconds. Use for relative requests: one hour = 3600.",
          },
          run_once_at: {
            type: "string",
            description:
              "Absolute ISO-8601 timestamp for a one-off, including Z or an explicit UTC offset. " +
              "Use delay_seconds instead for 'in N minutes/hours'.",
          },
        },
        required: ["title", "instruction"],
      },
      async execute(args, ctx): Promise<ToolResult> {
        const title = String(args["title"] ?? "").trim();
        const instruction = String(args["instruction"] ?? "").trim();
        if (!title || !instruction) {
          return { content: "Both title and instruction are required.", isError: true };
        }

        const intervalSeconds = args["interval_seconds"]
          ? Number(args["interval_seconds"])
          : undefined;
        const cron = args["cron"] ? String(args["cron"]) : undefined;
        const delaySeconds = args["delay_seconds"] ? Number(args["delay_seconds"]) : undefined;
        const runOnceAt = args["run_once_at"] ? new Date(String(args["run_once_at"])) : undefined;

        if ([intervalSeconds, cron, delaySeconds, runOnceAt].filter(Boolean).length !== 1) {
          return {
            content:
              "Give exactly one of interval_seconds, cron, delay_seconds or run_once_at — not none and not several.",
            isError: true,
          };
        }
        if (runOnceAt && Number.isNaN(runOnceAt.getTime())) {
          return { content: `"${String(args["run_once_at"])}" is not a valid timestamp.`, isError: true };
        }
        if (runOnceAt && !/(?:Z|[+-]\d{2}:\d{2})$/u.test(String(args["run_once_at"]))) {
          return {
            content: "run_once_at must include a timezone, for example 2026-08-09T18:30:00+02:00.",
            isError: true,
          };
        }
        if (delaySeconds !== undefined && (!Number.isInteger(delaySeconds) || delaySeconds < 60)) {
          return { content: "delay_seconds must be an integer of at least 60.", isError: true };
        }
        const scheduledAt =
          runOnceAt ?? (delaySeconds !== undefined ? new Date(Date.now() + delaySeconds * 1000) : undefined);

        const schedule = {
          kind: scheduledAt ? ("once" as const) : cron ? ("cron" as const) : ("interval" as const),
          intervalSeconds: intervalSeconds ?? null,
          cron: cron ?? null,
          // Tasks the agent creates follow the deployment's zone; it has no
          // reliable way to know the user's and would otherwise guess UTC.
          timezone: process.env["QUIET_HOURS_TIMEZONE"] ?? "Europe/Berlin",
        };

        try {
          const task = await deps.taskService.create({
            userId: ctx.userId,
            title,
            kind: "agent",
            prompt: instruction,
            channel: (ctx.channel as ChannelName) ?? "telegram",
            schedule,
            ...(scheduledAt ? { runAt: scheduledAt } : {}),
            createdBy: "agent",
          });
          return {
            content:
              `Scheduled "${task.title}" (${describeSchedule(schedule)}), ` +
              `first run ${task.nextRunAt?.toISOString() ?? "unknown"}. Task id ${task.id}.`,
          };
        } catch (err) {
          return { content: `Could not schedule that: ${(err as Error).message}`, isError: true };
        }
      },
    },

    {
      name: "task_list",
      description:
        "List the scheduled tasks that currently exist, with their schedules and when each " +
        "last ran. Check this before creating a task, so you do not end up with two that do " +
        "the same thing.",
      source: "builtin",
      sideEffects: false,
      inputSchema: { type: "object", properties: {} },
      async execute(_args, ctx): Promise<ToolResult> {
        const rows = await deps.tasks.list(ctx.userId);
        if (rows.length === 0) return { content: "No tasks scheduled." };
        return {
          content: rows
            .map((task) => {
              const schedule = describeSchedule({
                kind: task.scheduleKind,
                intervalSeconds: task.intervalSeconds,
                cron: task.cron,
                timezone: task.timezone,
              });
              const state = task.enabled ? "enabled" : "disabled";
              const last = task.lastRunAt ? `last ran ${task.lastRunAt.toISOString()}` : "never run";
              return `- ${task.title} [${task.id}] ${schedule}, ${state}, ${last}, by ${task.createdBy}\n  ${task.prompt}`;
            })
            .join("\n"),
        };
      },
    },

    {
      name: "task_cancel",
      description:
        "Cancel a scheduled task by its id, from task_list. Use it when the task is no longer " +
        "wanted or has been superseded — not as a way to silence a task that is failing, which " +
        "the owner needs to know about.",
      source: "builtin",
      sideEffects: true,
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string", description: "The id from task_list." } },
        required: ["task_id"],
      },
      async execute(args, ctx): Promise<ToolResult> {
        const id = String(args["task_id"] ?? "");
        const task = await deps.tasks.get(id);
        if (!task || task.userId !== ctx.userId) {
          return { content: `No task with id ${id}.`, isError: true };
        }
        await deps.tasks.delete(id);
        return { content: `Cancelled "${task.title}".` };
      },
    },
  ];

  // Only offered when something can actually receive it, so the model is never
  // shown a way to reach the user that silently goes nowhere.
  if (channels.length > 0) {
    tools.push({
      name: "send_message",
      description:
        `Send the owner a message they did not ask for, on ${channels.join(" or ")}. ` +
        "This is the middle option between staying silent and phoning them: use it when " +
        "something is worth knowing but not worth interrupting them for.\n\n" +
        "During a normal conversation you do not need this — just reply. It is for scheduled " +
        "runs and for anything you notice while nobody is watching.",
      source: "builtin",
      sideEffects: true,
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The message, written to be read on a phone." },
          channel: {
            type: "string",
            enum: channels,
            description: `Where to send it. Defaults to ${channels[0]}.`,
          },
        },
        required: ["text"],
      },
      async execute(args, ctx): Promise<ToolResult> {
        const text = String(args["text"] ?? "").trim();
        if (!text) return { content: "Nothing to send.", isError: true };
        const channel = (String(args["channel"] ?? channels[0]) as ChannelName) ?? channels[0]!;

        const result = await deps.notifications.send(ctx.userId, channel, text);
        return result.delivered
          ? { content: `Sent on ${channel}.` }
          : { content: `Not sent: ${result.reason ?? "unknown error"}`, isError: true };
      },
    });
  }

  return tools;
}
