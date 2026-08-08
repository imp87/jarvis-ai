-- Per-user, per-channel preferences (component 9).
--
-- The reply format is a stored setting, not a mirror of the incoming message:
-- sending a voice note must not imply wanting one back. The admin UI edits this
-- table; the orchestrator reads it and tells the adapter what to render.

CREATE TABLE IF NOT EXISTS user_channel_settings (
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel      text        NOT NULL,
    reply_format text        NOT NULL DEFAULT 'text' CHECK (reply_format IN ('text', 'voice')),
    -- Provider-specific voice id (Piper model name, OpenAI voice, …). NULL = provider default.
    voice_id     text,
    -- BCP-47-ish language hint passed to both STT and TTS.
    language     text        NOT NULL DEFAULT 'de',
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel)
);
