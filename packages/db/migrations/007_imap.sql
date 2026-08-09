-- Original single-mailbox cursor tables. Kept immutable because a deployment
-- may already have applied this migration; 008 adds the account registry used
-- by the UI-driven implementation.
CREATE TABLE IF NOT EXISTS imap_mailbox_cursors (
    mailbox_key    text        PRIMARY KEY,
    uid_validity   text        NOT NULL,
    last_uid       integer     NOT NULL CHECK (last_uid >= 0),
    initialized_at timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS imap_messages (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mailbox_key   text        NOT NULL,
    uid_validity  text        NOT NULL,
    uid           integer     NOT NULL CHECK (uid > 0),
    message_id    text,
    from_address  text        NOT NULL,
    subject       text        NOT NULL,
    received_at   timestamptz NOT NULL,
    body_text     text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (mailbox_key, uid_validity, uid)
);

CREATE INDEX IF NOT EXISTS imap_messages_created_idx ON imap_messages (created_at DESC);
