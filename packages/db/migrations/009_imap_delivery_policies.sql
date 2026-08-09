-- Per-mailbox routing policy. Keeping this as JSONB makes the rules extensible
-- without forcing every future delivery option through an environment variable.
ALTER TABLE imap_accounts
  ADD COLUMN IF NOT EXISTS delivery_policy jsonb NOT NULL DEFAULT
  '{"low":"none","normal":"telegram","urgent":"call","callFallback":"telegram","callRetryCount":1,"callRetryDelayMinutes":20,"replyMode":"draft","instructions":""}'::jsonb;

-- A durable record for a call triggered by an important email. The retry worker
-- survives an orchestrator restart and only retries calls which were never
-- connected; a connected call is considered delivered.
CREATE TABLE IF NOT EXISTS imap_delivery_events (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id               uuid NOT NULL REFERENCES imap_accounts (id) ON DELETE CASCADE,
    message_id               uuid NOT NULL REFERENCES imap_account_messages (id) ON DELETE CASCADE,
    user_id                  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    summary                  text NOT NULL,
    reply_draft              text,
    fallback_channel         text NOT NULL CHECK (fallback_channel IN ('none', 'telegram', 'discord')),
    call_context             text NOT NULL,
    call_id                  uuid REFERENCES call_logs (id) ON DELETE SET NULL,
    calls_attempted          integer NOT NULL DEFAULT 0 CHECK (calls_attempted >= 0),
    max_call_attempts        integer NOT NULL DEFAULT 0 CHECK (max_call_attempts BETWEEN 0 AND 4),
    retry_delay_minutes      integer NOT NULL DEFAULT 20 CHECK (retry_delay_minutes BETWEEN 1 AND 1440),
    retry_at                 timestamptz,
    state                    text NOT NULL DEFAULT 'awaiting_call'
        CHECK (state IN ('awaiting_call', 'retry_scheduled', 'delivered', 'fallback_sent')),
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS imap_delivery_events_due_idx
  ON imap_delivery_events (retry_at)
  WHERE state = 'retry_scheduled';
CREATE INDEX IF NOT EXISTS imap_delivery_events_call_idx
  ON imap_delivery_events (call_id)
  WHERE call_id IS NOT NULL;
