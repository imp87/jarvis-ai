import type { ConversationRepository, TaskRepository, TaskRow } from "@jarvis/db";
import type { ChannelName, Logger } from "@jarvis/shared";
import type { AgentLoop } from "../agent/loop.js";
import type { NotificationService } from "./notify.js";
import { nextRunAt } from "./schedule.js";

interface RunOutcome {
  status: "ok" | "failed";
  summary: string;
  /** Agent runs only; a notify task has no steps and calls no tools. */
  steps?: number;
  toolCalls?: string[];
}

export interface TaskRunnerOptions {
  /** How often to look for due work. */
  pollIntervalMs?: number;
  /** How many tasks one tick may take. Bounds a thundering herd after downtime. */
  batchSize?: number;
  /** A claim older than this is assumed to belong to a crashed runner. */
  staleClaimMs?: number;
}

/**
 * Executes scheduled work.
 *
 * The decision this makes, and the reason it exists rather than being folded
 * into the agent: **whether to involve the model at all**. A `notify` task is a
 * message with a timestamp — running an agent loop for it would cost a request
 * and several thousand tokens to reproduce text that was already written. Only
 * `agent` tasks reach the loop.
 */
export class TaskRunner {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly tasks: TaskRepository,
    private readonly conversations: ConversationRepository,
    private readonly agent: AgentLoop,
    private readonly notifications: NotificationService,
    private readonly logger: Logger,
    private readonly options: TaskRunnerOptions = {},
  ) {}

  start(): void {
    const interval = this.options.pollIntervalMs ?? 20_000;
    this.logger.info({ pollIntervalMs: interval }, "task runner started");
    // `unref` so a pending poll never keeps the process alive during shutdown.
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** One poll. Public so a test — or an operator — can drive it directly. */
  async tick(): Promise<number> {
    // Ticks must not overlap: a slow agent run would otherwise let the next
    // tick claim and run the same backlog again.
    if (this.ticking || this.stopped) return 0;
    this.ticking = true;
    try {
      const due = await this.tasks.claimDue(
        this.options.batchSize ?? 5,
        this.options.staleClaimMs ?? 10 * 60_000,
      );
      // Sequential on purpose: several agent runs at once would multiply the
      // token spend at exactly the moment a backlog is being cleared.
      for (const task of due) {
        if (this.stopped) break;
        await this.runOne(task);
      }
      return due.length;
    } catch (err) {
      this.logger.error({ err: String(err) }, "task poll failed");
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  /** Runs a task now, regardless of its schedule. Used by "run now" in the UI. */
  async runNow(task: TaskRow): Promise<{ status: "ok" | "failed"; summary: string }> {
    return this.execute(task);
  }

  private async runOne(task: TaskRow): Promise<void> {
    const outcome = await this.execute(task);

    let next: Date | null = null;
    try {
      next = nextRunAt(
        {
          kind: task.scheduleKind,
          intervalSeconds: task.intervalSeconds,
          cron: task.cron,
          timezone: task.timezone,
        },
        new Date(),
      );
    } catch (err) {
      // A schedule that stopped parsing must not leave the task claimed and
      // invisible. Disable it (next = null) and say why.
      this.logger.error(
        { taskId: task.id, err: String(err) },
        "task schedule is invalid; disabling it",
      );
    }

    await this.tasks.completeRun(task.id, {
      status: outcome.status,
      error: outcome.status === "failed" ? outcome.summary : null,
      nextRunAt: next,
    });
  }

  private async execute(task: TaskRow): Promise<{ status: "ok" | "failed"; summary: string }> {
    const started = Date.now();
    const log = this.logger.child?.({ taskId: task.id, title: task.title }) ?? this.logger;

    try {
      // The whole point of `kind`: a notify task never reaches the model.
      const result: RunOutcome =
        task.kind === "notify" ? await this.runNotify(task) : await this.runAgent(task);

      await this.tasks.recordRun({
        taskId: task.id,
        status: result.status,
        summary: result.summary,
        ...(result.status === "failed" ? { error: result.summary } : {}),
        ...(result.steps !== undefined ? { steps: result.steps } : {}),
        ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
        durationMs: Date.now() - started,
      });

      log.info(
        { kind: task.kind, status: result.status, durationMs: Date.now() - started },
        "task run finished",
      );
      return { status: result.status, summary: result.summary };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.tasks
        .recordRun({
          taskId: task.id,
          status: "failed",
          error: message,
          durationMs: Date.now() - started,
        })
        .catch(() => undefined);
      log.error({ err: message }, "task run failed");
      return { status: "failed", summary: message };
    }
  }

  /** No model involved: the text was written when the task was created. */
  private async runNotify(task: TaskRow): Promise<{
    status: "ok" | "failed";
    summary: string;
  }> {
    const result = await this.notifications.send(
      task.userId,
      task.channel as ChannelName,
      task.prompt,
    );
    return result.delivered
      ? { status: "ok", summary: task.prompt }
      : { status: "failed", summary: result.reason ?? "delivery failed" };
  }

  private async runAgent(task: TaskRow): Promise<{
    status: "ok" | "failed";
    summary: string;
    steps?: number;
    toolCalls?: string[];
  }> {
    // One conversation per task, reused. Without it a five-minute mail check
    // has no idea it already reported the same message five minutes ago — and
    // would call about it again, and again.
    let conversationId = task.conversationId;
    if (!conversationId) {
      const conversation = await this.conversations.create(task.userId, `Task: ${task.title}`);
      conversationId = conversation.id;
      await this.tasks.setConversation(task.id, conversationId);
    }

    const result = await this.agent.run({
      userId: task.userId,
      // Scheduled work can place a call. Keep the same owner form of address
      // as the live voice channel so the generated call context is consistent.
      ownerName: "Master",
      conversationId,
      channel: task.channel as ChannelName,
      text: task.prompt,
      profile: task.profile ?? undefined,
    });

    return {
      status: "ok",
      summary: result.reply,
      steps: result.steps,
      toolCalls: result.toolCalls,
    };
  }
}
