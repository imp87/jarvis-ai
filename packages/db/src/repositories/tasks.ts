import type pg from "pg";

export type TaskKind = "agent" | "notify";
export type ScheduleKind = "interval" | "cron" | "once";
export type TaskCreator = "user" | "agent";

export interface TaskRow {
  id: string;
  userId: string;
  title: string;
  kind: TaskKind;
  prompt: string;
  channel: string;
  profile: string | null;
  scheduleKind: ScheduleKind;
  intervalSeconds: number | null;
  cron: string | null;
  timezone: string;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  enabled: boolean;
  createdBy: TaskCreator;
  conversationId: string | null;
  runCount: number;
  failureCount: number;
  lastStatus: string | null;
  lastError: string | null;
  claimedAt: Date | null;
  createdAt: Date;
}

export interface TaskRunRow {
  id: string;
  taskId: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: "ok" | "failed";
  summary: string | null;
  error: string | null;
  steps: number | null;
  toolCalls: string[];
  durationMs: number | null;
}

const COLUMNS = `id, user_id, title, kind, prompt, channel, profile,
                 schedule_kind, interval_seconds, cron, timezone,
                 next_run_at, last_run_at, enabled, created_by, conversation_id,
                 run_count, failure_count, last_status, last_error, claimed_at, created_at`;

export class TaskRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(userId?: string): Promise<TaskRow[]> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM tasks
        WHERE ($1::uuid IS NULL OR user_id = $1)
        ORDER BY enabled DESC, next_run_at NULLS LAST, created_at DESC`,
      [userId ?? null],
    );
    return (rows as Array<Record<string, unknown>>).map(mapTask);
  }

  async get(id: string): Promise<TaskRow | null> {
    const { rows } = await this.pool.query(`SELECT ${COLUMNS} FROM tasks WHERE id = $1`, [id]);
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapTask(row) : null;
  }

  async countForCreator(userId: string, createdBy: TaskCreator): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) FROM tasks WHERE user_id = $1 AND created_by = $2 AND enabled`,
      [userId, createdBy],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async create(input: {
    userId: string;
    title: string;
    kind: TaskKind;
    prompt: string;
    channel: string;
    profile?: string | null;
    scheduleKind: ScheduleKind;
    intervalSeconds?: number | null;
    cron?: string | null;
    timezone: string;
    nextRunAt: Date | null;
    createdBy: TaskCreator;
    conversationId?: string | null;
  }): Promise<TaskRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO tasks (user_id, title, kind, prompt, channel, profile,
                          schedule_kind, interval_seconds, cron, timezone,
                          next_run_at, created_by, conversation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING ${COLUMNS}`,
      [
        input.userId,
        input.title,
        input.kind,
        input.prompt,
        input.channel,
        input.profile ?? null,
        input.scheduleKind,
        input.intervalSeconds ?? null,
        input.cron ?? null,
        input.timezone,
        input.nextRunAt,
        input.createdBy,
        input.conversationId ?? null,
      ],
    );
    return mapTask(rows[0] as Record<string, unknown>);
  }

  async update(
    id: string,
    patch: {
      title?: string;
      prompt?: string;
      enabled?: boolean;
      profile?: string | null;
      scheduleKind?: ScheduleKind;
      intervalSeconds?: number | null;
      cron?: string | null;
      timezone?: string;
      nextRunAt?: Date | null;
    },
  ): Promise<TaskRow | null> {
    const columns: Array<[keyof typeof patch, string]> = [
      ["title", "title"],
      ["prompt", "prompt"],
      ["enabled", "enabled"],
      ["profile", "profile"],
      ["scheduleKind", "schedule_kind"],
      ["intervalSeconds", "interval_seconds"],
      ["cron", "cron"],
      ["timezone", "timezone"],
      ["nextRunAt", "next_run_at"],
    ];
    const assignments: string[] = [];
    const values: unknown[] = [id];
    for (const [key, column] of columns) {
      if (!(key in patch)) continue;
      values.push(patch[key] ?? null);
      assignments.push(`${column} = $${values.length}`);
    }
    if (assignments.length === 0) return this.get(id);

    const { rows } = await this.pool.query(
      `UPDATE tasks SET ${assignments.join(", ")}, updated_at = now()
        WHERE id = $1 RETURNING ${COLUMNS}`,
      values,
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapTask(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM tasks WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async setConversation(id: string, conversationId: string): Promise<void> {
    await this.pool.query(`UPDATE tasks SET conversation_id = $2 WHERE id = $1`, [
      id,
      conversationId,
    ]);
  }

  /**
   * Takes ownership of up to `limit` due tasks in one statement.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes a second orchestrator safe: two
   * pollers running the same query take disjoint sets instead of both running
   * the same task — which for a task that phones you means being called twice.
   */
  async claimDue(limit: number, staleClaimMs: number): Promise<TaskRow[]> {
    // A runner that died mid-task leaves claimed_at set forever; releasing old
    // claims is what stops one crash from silently retiring a task.
    await this.pool.query(
      `UPDATE tasks SET claimed_at = NULL
        WHERE claimed_at IS NOT NULL AND claimed_at < now() - ($1 || ' milliseconds')::interval`,
      [String(staleClaimMs)],
    );

    const { rows } = await this.pool.query(
      `UPDATE tasks SET claimed_at = now()
        WHERE id IN (
          SELECT id FROM tasks
           WHERE enabled AND claimed_at IS NULL
             AND next_run_at IS NOT NULL AND next_run_at <= now()
           ORDER BY next_run_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING ${COLUMNS}`,
      [limit],
    );
    return (rows as Array<Record<string, unknown>>).map(mapTask);
  }

  /** Releases the claim and schedules the next run. */
  async completeRun(
    id: string,
    outcome: { status: "ok" | "failed"; error?: string | null; nextRunAt: Date | null },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE tasks
          SET claimed_at    = NULL,
              last_run_at   = now(),
              next_run_at   = $2,
              last_status   = $3,
              last_error    = $4,
              run_count     = run_count + 1,
              failure_count = CASE WHEN $3 = 'failed' THEN failure_count + 1 ELSE 0 END,
              -- A one-off has nothing left to do; disabling it keeps the row and
              -- its history rather than deleting what just happened.
              enabled       = CASE WHEN $2::timestamptz IS NULL THEN false ELSE enabled END,
              updated_at    = now()
        WHERE id = $1`,
      [id, outcome.nextRunAt, outcome.status, outcome.error ?? null],
    );
  }

  async recordRun(input: {
    taskId: string;
    status: "ok" | "failed";
    summary?: string | null;
    error?: string | null;
    steps?: number | null;
    toolCalls?: string[];
    durationMs: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO task_runs (task_id, finished_at, status, summary, error, steps, tool_calls, duration_ms)
       VALUES ($1, now(), $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        input.taskId,
        input.status,
        input.summary ?? null,
        input.error ?? null,
        input.steps ?? null,
        JSON.stringify(input.toolCalls ?? []),
        Math.round(input.durationMs),
      ],
    );
  }

  async listRuns(taskId: string, limit = 20): Promise<TaskRunRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id, task_id, started_at, finished_at, status, summary, error, steps, tool_calls, duration_ms
         FROM task_runs WHERE task_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [taskId, limit],
    );
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: String(r["id"]),
      taskId: String(r["task_id"]),
      startedAt: r["started_at"] as Date,
      finishedAt: (r["finished_at"] as Date | null) ?? null,
      status: r["status"] as "ok" | "failed",
      summary: (r["summary"] as string | null) ?? null,
      error: (r["error"] as string | null) ?? null,
      steps: r["steps"] === null ? null : Number(r["steps"]),
      toolCalls: (r["tool_calls"] as string[] | null) ?? [],
      durationMs: r["duration_ms"] === null ? null : Number(r["duration_ms"]),
    }));
  }
}

function mapTask(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r["id"]),
    userId: String(r["user_id"]),
    title: String(r["title"]),
    kind: r["kind"] as TaskKind,
    prompt: String(r["prompt"]),
    channel: String(r["channel"]),
    profile: (r["profile"] as string | null) ?? null,
    scheduleKind: r["schedule_kind"] as ScheduleKind,
    intervalSeconds: r["interval_seconds"] === null ? null : Number(r["interval_seconds"]),
    cron: (r["cron"] as string | null) ?? null,
    timezone: String(r["timezone"]),
    nextRunAt: (r["next_run_at"] as Date | null) ?? null,
    lastRunAt: (r["last_run_at"] as Date | null) ?? null,
    enabled: Boolean(r["enabled"]),
    createdBy: r["created_by"] as TaskCreator,
    conversationId: (r["conversation_id"] as string | null) ?? null,
    runCount: Number(r["run_count"] ?? 0),
    failureCount: Number(r["failure_count"] ?? 0),
    lastStatus: (r["last_status"] as string | null) ?? null,
    lastError: (r["last_error"] as string | null) ?? null,
    claimedAt: (r["claimed_at"] as Date | null) ?? null,
    createdAt: r["created_at"] as Date,
  };
}
