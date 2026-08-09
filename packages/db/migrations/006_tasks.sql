-- Scheduled work: "check my mail every five minutes and call me if it matters".
--
-- Two kinds, because not every recurring job is worth a model call. An `agent`
-- task runs the full loop with tools; a `notify` task delivers a fixed message
-- and costs nothing. Deciding that here rather than inside the agent is what
-- keeps a daily reminder from costing an LLM request every day.

CREATE TABLE IF NOT EXISTS tasks (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title         text        NOT NULL,
    kind          text        NOT NULL CHECK (kind IN ('agent', 'notify')),

    -- agent: the instruction handed to the loop. notify: the literal message.
    prompt        text        NOT NULL,
    -- Which channel this speaks on: the reply target for notify, and the
    -- channel context (and therefore the tool set) for agent runs.
    channel       text        NOT NULL DEFAULT 'telegram',
    -- LLM routing profile for agent runs. NULL uses the router default.
    profile       text,

    -- --- Schedule ---------------------------------------------------------
    schedule_kind text        NOT NULL CHECK (schedule_kind IN ('interval', 'cron', 'once')),
    -- Floor of 60s: anything faster is a busy loop with an API bill attached.
    interval_seconds integer  CHECK (interval_seconds >= 60),
    cron          text,
    -- Cron is evaluated in this zone; without it "08:00" drifts with the server.
    timezone      text        NOT NULL DEFAULT 'Europe/Berlin',
    next_run_at   timestamptz,
    last_run_at   timestamptz,

    -- --- State ------------------------------------------------------------
    enabled       boolean     NOT NULL DEFAULT true,
    -- Tasks the agent created for itself are capped separately and shown apart,
    -- so a runaway self-scheduling loop is visible rather than buried.
    created_by    text        NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'agent')),
    -- One conversation per task, reused across runs. Without shared context the
    -- five-minute mail check would report the same message every five minutes.
    conversation_id uuid      REFERENCES conversations (id) ON DELETE SET NULL,
    run_count     integer     NOT NULL DEFAULT 0,
    failure_count integer     NOT NULL DEFAULT 0,
    last_status   text,
    last_error    text,
    -- Held while a runner owns this task. A crashed runner leaves it set, so the
    -- poller releases claims older than a few minutes rather than stalling.
    claimed_at    timestamptz,

    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    -- The schedule fields a kind needs must actually be present; a cron task
    -- with no expression would sit at next_run_at NULL and never run, silently.
    CONSTRAINT tasks_schedule_complete CHECK (
        (schedule_kind = 'interval' AND interval_seconds IS NOT NULL)
     OR (schedule_kind = 'cron'     AND cron IS NOT NULL)
     OR (schedule_kind = 'once')
    )
);

-- The poller's only query: enabled, due, unclaimed.
CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks (next_run_at)
    WHERE enabled AND claimed_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_user_idx ON tasks (user_id);

-- ---------------------------------------------------------------------------
-- One row per execution. This is what makes "why did it call me at 3am"
-- answerable, and it is deliberately separate from the conversation: a run that
-- decided to do nothing still happened.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_runs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id     uuid        NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    status      text        NOT NULL CHECK (status IN ('ok', 'failed')),
    -- The agent's reply, or the delivered text for a notify task.
    summary     text,
    error       text,
    steps       integer,
    tool_calls  jsonb       NOT NULL DEFAULT '[]'::jsonb,
    duration_ms integer
);

CREATE INDEX IF NOT EXISTS task_runs_task_idx ON task_runs (task_id, started_at DESC);
