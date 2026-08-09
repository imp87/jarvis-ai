-- SMTP is separate from IMAP: receiving credentials must never silently grant
-- sending rights. Passwords are AES-GCM envelopes and never returned by the API.
ALTER TABLE imap_accounts
  ADD COLUMN IF NOT EXISTS smtp_host text,
  ADD COLUMN IF NOT EXISTS smtp_port integer NOT NULL DEFAULT 587 CHECK (smtp_port BETWEEN 1 AND 65535),
  ADD COLUMN IF NOT EXISTS smtp_secure boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS smtp_username text,
  ADD COLUMN IF NOT EXISTS smtp_password_enc text,
  ADD COLUMN IF NOT EXISTS smtp_from text;

CREATE TABLE IF NOT EXISTS imap_reply_drafts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      uuid NOT NULL REFERENCES imap_accounts (id) ON DELETE CASCADE,
    message_id      uuid NOT NULL REFERENCES imap_account_messages (id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    to_address      text NOT NULL,
    subject         text NOT NULL,
    body_text       text NOT NULL,
    in_reply_to     text,
    status          text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'cancelled')),
    sent_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS imap_reply_drafts_pending_idx
  ON imap_reply_drafts (user_id, created_at DESC)
  WHERE status = 'pending';
