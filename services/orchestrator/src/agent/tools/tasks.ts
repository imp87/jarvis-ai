import type { TaskRepository } from "@jarvis/db";
import {
  dateInZone,
  describeNow,
  isUsableTimeZone,
  wallTimeToUtc,
  type ChannelName,
  type ExecutableTool,
  type ToolResult,
} from "@jarvis/shared";
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
  /** The owner's zone. Every wall-clock time below is read in it. */
  timezone: string;
}): ExecutableTool[] {
  const channels = deps.notifications.availableChannels();
  // A misconfigured zone must not silently become UTC and shift every reminder
  // by an hour or two; fall back to the deployment's home zone instead.
  const timezone = isUsableTimeZone(deps.timezone) ? deps.timezone : "Europe/Berlin";

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
        "Pick the schedule form by what the user said, and never do date or time arithmetic " +
        "yourself — every form below is converted for you:\n" +
        "- A clock time on a given day ('morgen um 07:45', 'am 20. um 14 Uhr'): `run_on` as " +
        "YYYY-MM-DD plus `run_at` as HH:MM. Read the local date from '# Now' and count days " +
        "forward; do not convert to UTC and do not compute a delay.\n" +
        "- A relative time ('in einer Stunde'): `delay_seconds` (3600 for one hour).\n" +
        "- Something genuinely repeating ('jeden Werktag um 8'): `cron` ('0 8 * * 1-5') or " +
        "`interval_seconds`. A cron with a fixed day-of-month and month is always a mistake — " +
        "that fires once a year. Use `run_on`/`run_at` for a single date.\n\n" +
        "Do not schedule anything faster than every 5 minutes. If a scheduled task places a " +
        "phone call, make its first spoken context state the concrete reminder in German — " +
        "never a generic 'What can I do for you?' greeting.",
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
          run_on: {
            type: "string",
            description:
              "Day of a one-off, as YYYY-MM-DD in the user's local calendar. Pair with run_at.",
          },
          run_at: {
            type: "string",
            description:
              "Local clock time of a one-off, as HH:MM in the user's timezone. Pair with run_on.",
          },
          run_once_at: {
            type: "string",
            description:
              "Absolute ISO-8601 timestamp for a one-off, including Z or an explicit UTC offset. " +
              "Prefer run_on/run_at; this exists for a timestamp you were literally given.",
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
        const runOn = args["run_on"] ? String(args["run_on"]).trim() : undefined;
        const runAtClock = args["run_at"] ? String(args["run_at"]).trim() : undefined;

        // run_on and run_at are one form in two fields; either alone is a
        // half-specified time, which is exactly the kind of thing that would
        // otherwise be silently completed with a guess.
        if (Boolean(runOn) !== Boolean(runAtClock)) {
          return {
            content: "run_on and run_at go together: give the day as YYYY-MM-DD and the time as HH:MM.",
            isError: true,
          };
        }
        const wallClock = runOn && runAtClock ? parseWallClock(runOn, runAtClock, timezone) : undefined;
        if (runOn && runAtClock && !wallClock) {
          return {
            content: `"${runOn} ${runAtClock}" is not a valid date and time. Use YYYY-MM-DD and HH:MM.`,
            isError: true,
          };
        }

        if ([intervalSeconds, cron, delaySeconds, runOnceAt, wallClock].filter(Boolean).length !== 1) {
          return {
            content:
              "Give exactly one schedule: run_on with run_at, delay_seconds, run_once_at, " +
              "interval_seconds, or cron — not none and not several.",
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
          wallClock ??
          runOnceAt ??
          (delaySeconds !== undefined ? new Date(Date.now() + delaySeconds * 1000) : undefined);

        const schedule = {
          kind: scheduledAt ? ("once" as const) : cron ? ("cron" as const) : ("interval" as const),
          intervalSeconds: intervalSeconds ?? null,
          cron: cron ?? null,
          // Tasks the agent creates follow the owner's zone, injected at wiring
          // time. It has no reliable way to know it and would otherwise guess UTC.
          timezone,
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
              `Scheduled "${task.title}" (${describeSchedule(schedule)}), first run ` +
              // Confirmed in local time: an ISO string in UTC is what the user
              // would have to convert back, and it is what made a 07:45 reminder
              // land at 11:34 in the first place.
              `${task.nextRunAt ? describeNow(task.nextRunAt, timezone) : "unknown"}. ` +
              `Task id ${task.id}.`,
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

/**
 * "2026-08-11" + "07:45" in the owner's zone, as the instant it denotes.
 *
 * This is the whole point of the wall-clock form: the conversion happens here,
 * with a real timezone database, instead of in a model that has to subtract two
 * timestamps and get DST right.
 */
export function parseWallClock(day: string, clock: string, timeZone: string): Date | undefined {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  const time = /^(\d{1,2})[:.](\d{2})$/.exec(clock.trim());
  if (!date || !time) return undefined;

  const [year, month, dayOfMonth] = [Number(date[1]), Number(date[2]), Number(date[3])];
  const [hour, minute] = [Number(time[1]), Number(time[2])];
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return undefined;
  if (hour > 23 || minute > 59) return undefined;

  const instant = wallTimeToUtc([year, month, dayOfMonth, hour, minute, 0], timeZone, "UTC");
  // Rejects 31 April and friends: the calendar would have rolled them into the
  // next month, quietly scheduling a reminder for a day the user did not name.
  const [checkYear, checkMonth, checkDay] = dateInZone(instant, timeZone);
  if (checkYear !== year || checkMonth !== month || checkDay !== dayOfMonth) return undefined;
  return instant;
}
