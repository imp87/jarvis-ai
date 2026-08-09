import type { TaskCreator, TaskRepository, TaskRow } from "@jarvis/db";
import { AppError } from "@jarvis/shared";
import { MIN_INTERVAL_SECONDS, nextRunAt, validateSchedule, type Schedule } from "./schedule.js";

export interface CreateTaskInput {
  userId: string;
  title: string;
  kind: "agent" | "notify";
  prompt: string;
  channel: string;
  profile?: string | null;
  schedule: Schedule;
  /** Only for `once`: when it should fire. */
  runAt?: Date | null;
  createdBy: TaskCreator;
}

export interface TaskLimits {
  /** Floor for tasks the agent schedules for itself. */
  agentMinIntervalSeconds: number;
  /** How many enabled tasks the agent may hold at once. */
  agentMaxTasks: number;
}

export const DEFAULT_TASK_LIMITS: TaskLimits = {
  // Five minutes is the fastest thing anyone has actually asked for, and it is
  // already 288 agent runs a day.
  agentMinIntervalSeconds: 300,
  agentMaxTasks: 20,
};

/**
 * Creating and validating scheduled work.
 *
 * The limits here apply only to tasks the *agent* creates. A person typing into
 * the admin UI is making a deliberate decision and can pick a one-minute
 * interval if they mean it; a model that schedules itself every minute has
 * built a spend loop nobody asked for, and it will not be noticed until the
 * bill arrives.
 */
export class TaskService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly limits: TaskLimits = DEFAULT_TASK_LIMITS,
  ) {}

  async create(input: CreateTaskInput): Promise<TaskRow> {
    if (input.createdBy === "agent") await this.enforceAgentLimits(input);

    validateSchedule(input.schedule);

    const firstRun =
      input.schedule.kind === "once"
        ? (input.runAt ?? new Date())
        : nextRunAt(input.schedule, new Date());

    // A past one-off is not "close enough": the runner claims it on its next
    // poll and turns a requested future reminder into an immediate action.
    if (input.schedule.kind === "once" && firstRun && firstRun.getTime() < Date.now()) {
      throw new AppError("that time is in the past", 400, "schedule_in_past");
    }

    return this.tasks.create({
      userId: input.userId,
      title: input.title,
      kind: input.kind,
      prompt: input.prompt,
      channel: input.channel,
      profile: input.profile ?? null,
      scheduleKind: input.schedule.kind,
      intervalSeconds: input.schedule.intervalSeconds ?? null,
      cron: input.schedule.cron ?? null,
      timezone: input.schedule.timezone,
      nextRunAt: firstRun,
      createdBy: input.createdBy,
    });
  }

  private async enforceAgentLimits(input: CreateTaskInput): Promise<void> {
    const seconds = input.schedule.intervalSeconds ?? 0;
    if (input.schedule.kind === "interval" && seconds < this.limits.agentMinIntervalSeconds) {
      throw new AppError(
        `the shortest interval you may schedule for yourself is ` +
          `${this.limits.agentMinIntervalSeconds} seconds (you asked for ${seconds}). ` +
          `Ask the owner to create it in the admin UI if it genuinely needs to be faster.`,
        400,
        "interval_too_short",
      );
    }

    const open = await this.tasks.countForCreator(input.userId, "agent");
    if (open >= this.limits.agentMaxTasks) {
      throw new AppError(
        `you already have ${open} scheduled tasks, which is the limit. ` +
          `Cancel one you no longer need before creating another.`,
        409,
        "too_many_tasks",
      );
    }
  }

  /** Recomputes the next run after a schedule change, so an edit takes effect. */
  async reschedule(id: string, schedule: Schedule): Promise<TaskRow | null> {
    validateSchedule(schedule);
    return this.tasks.update(id, {
      scheduleKind: schedule.kind,
      intervalSeconds: schedule.intervalSeconds ?? null,
      cron: schedule.cron ?? null,
      timezone: schedule.timezone,
      nextRunAt: schedule.kind === "once" ? null : nextRunAt(schedule, new Date()),
    });
  }
}

export { MIN_INTERVAL_SECONDS };
