-- Core identity, conversation and audit tables.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Users and channel identities
--
-- Only registered channel identities may talk to the agent. An unknown Telegram
-- user who finds the bot gets nothing — the lookup simply misses.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name text        NOT NULL,
    is_owner     boolean     NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identities (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel         text        NOT NULL,
    channel_user_id text        NOT NULL,
    -- Set false to revoke access without deleting history.
    enabled         boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (channel, channel_user_id)
);

CREATE INDEX IF NOT EXISTS identities_user_idx ON identities (user_id);

-- ---------------------------------------------------------------------------
-- Conversations are channel-independent on purpose: ask on Telegram, continue
-- by phone. The channel is recorded per message, not per thread.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title          text,
    last_active_at timestamptz NOT NULL DEFAULT now(),
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_user_active_idx
    ON conversations (user_id, last_active_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id              bigserial PRIMARY KEY,
    conversation_id uuid        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    role            text        NOT NULL CHECK (role IN ('user', 'assistant')),
    -- ContentBlock[] from @jarvis/shared.
    content         jsonb       NOT NULL,
    -- Provider-native content, replayed verbatim when the same provider serves
    -- the next turn (reasoning-block signatures must not be reconstructed).
    provider_echo   jsonb,
    channel         text,
    provider        text,
    model           text,
    input_tokens    integer,
    output_tokens   integer,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx
    ON messages (conversation_id, id);

-- ---------------------------------------------------------------------------
-- Voice calls (component 1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_logs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL,
    direction       text        NOT NULL CHECK (direction IN ('outbound', 'inbound')),
    to_number       text        NOT NULL,
    reason          text        NOT NULL,
    status          text        NOT NULL
        CHECK (status IN ('requested', 'blocked', 'dialing', 'in_progress', 'completed', 'failed')),
    blocked_reason  text,
    transcript      jsonb,
    provider_call_id text,
    duration_seconds integer,
    started_at      timestamptz,
    ended_at        timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_logs_created_idx ON call_logs (created_at DESC);
-- Powers the hourly/daily call budget check.
CREATE INDEX IF NOT EXISTS call_logs_placed_idx
    ON call_logs (created_at DESC)
    WHERE status IN ('dialing', 'in_progress', 'completed');

-- ---------------------------------------------------------------------------
-- Email classification audit trail (component 2)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_events (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_message_id text      NOT NULL UNIQUE,
    from_address      text        NOT NULL,
    subject           text        NOT NULL,
    summary           text,
    importance_score  numeric(3, 2) NOT NULL CHECK (importance_score BETWEEN 0 AND 1),
    reasoning         text,
    action_taken      text        NOT NULL
        CHECK (action_taken IN ('none', 'notified', 'called', 'suppressed')),
    suppressed_reason text,
    call_log_id       uuid REFERENCES call_logs (id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_events_created_idx ON email_events (created_at DESC);
