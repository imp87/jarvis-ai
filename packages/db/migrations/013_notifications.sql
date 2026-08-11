-- Outbound notifications, and the split between an ordinary call and an alarm.
--
-- Two things happen here. Calls learn which budget they draw on, and every
-- attempt to reach the owner gets a durable record instead of a log line.

-- ---------------------------------------------------------------------------
-- Call classes
-- ---------------------------------------------------------------------------
--
-- Until now every outbound call shared one hourly/daily counter: a reminder
-- about the bins and a report that an appointment exists only in a stranger's
-- calendar spent from the same allowance. That meant the alarm was most likely
-- to be blocked precisely on the days the system was busiest, which is when a
-- failure is most likely in the first place.
--
-- The budget exists to stop a storm, not to stop an alarm, so each class counts
-- separately. 'normal' is the default so every existing row keeps its meaning.
ALTER TABLE call_logs
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'normal';

ALTER TABLE call_logs
    DROP CONSTRAINT IF EXISTS call_logs_kind_check;
ALTER TABLE call_logs
    ADD CONSTRAINT call_logs_kind_check CHECK (kind IN ('normal', 'system_alert'));

-- The budget query filters by kind, so it has to be part of the index that
-- serves it. Replaces call_logs_placed_idx from 001_init.sql.
DROP INDEX IF EXISTS call_logs_placed_idx;
CREATE INDEX IF NOT EXISTS call_logs_placed_kind_idx
    ON call_logs (kind, created_at DESC)
    WHERE status IN ('dialing', 'in_progress', 'completed');

-- ---------------------------------------------------------------------------
-- Notification outbox
-- ---------------------------------------------------------------------------
--
-- Written BEFORE any delivery is attempted, not after it fails.
--
-- The obvious shape is to try each channel in turn and only persist once
-- everything has failed. That loses the record in exactly the case it matters:
-- each attempt carries a 30s timeout, so a chain is minutes long, and a restart
-- or a crash inside it leaves no trace that anything was ever meant to be sent.
-- Persisting first makes delivery retryable state rather than a single shot,
-- and makes "3 undelivered notifications" answerable from the admin UI.
--
-- Nothing here is written by the model. The rows are produced by the
-- orchestrator reporting on itself, with fixed wording — if the LLM is the part
-- that broke, it cannot also be the part that reports the breakage.
CREATE TABLE IF NOT EXISTS notifications (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- What happened, as a stable machine-readable slug ('calendar_write_failed',
    -- 'call_unreachable'). The operator-facing text is built from this in code,
    -- never generated, so it cannot drift or be steered.
    event           text        NOT NULL,

    -- Drives the channel chain. 'fatal' is reserved for the case where an
    -- external commitment exists and the local record of it does not: someone
    -- else is expecting the owner somewhere, and only the owner can resolve it.
    severity        text        NOT NULL DEFAULT 'info'
        CHECK (severity IN ('info', 'warning', 'fatal')),

    -- The rendered message, stored so what was sent can be read back exactly.
    body            text        NOT NULL,

    -- Structured detail for the admin UI: which calendar, which appointment,
    -- which call. Never secrets — this table is read by the UI.
    context         jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- One incident, one notification, however often the producer retries.
    -- The task runner re-runs failed work, and without this a single failed
    -- booking would dial once per attempt.
    idempotency_key text        NOT NULL UNIQUE,

    status          text        NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'delivered', 'exhausted')),

    -- The channel that finally worked, once one does.
    delivered_via   text,
    delivered_at    timestamptz,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One row per channel tried, so "we told you" can be substantiated afterwards
-- rather than asserted. A failed attempt is kept, not overwritten: knowing that
-- Telegram was down at 02:00 is what explains the phone call at 02:01.
CREATE TABLE IF NOT EXISTS notification_attempts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id uuid        NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
    channel         text        NOT NULL,
    delivered       boolean     NOT NULL,
    -- Why it failed: no adapter configured, identity disabled, HTTP 502,
    -- blocked by call policy. These are different problems with different
    -- fixes, and collapsing them into "failed" is what makes a silent drop
    -- silent.
    reason          text,
    attempted_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_pending_idx
    ON notifications (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS notifications_user_idx
    ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notification_attempts_parent_idx
    ON notification_attempts (notification_id, attempted_at);
