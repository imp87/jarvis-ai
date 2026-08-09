-- IMAP accounts are managed in the admin UI. Passwords use the same encrypted
-- envelope format as connector and MCP credentials; plaintext never reaches a
-- read API or an environment variable.

CREATE TABLE IF NOT EXISTS imap_accounts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name            text        NOT NULL,
    host            text        NOT NULL,
    port            integer     NOT NULL DEFAULT 993 CHECK (port BETWEEN 1 AND 65535),
    secure          boolean     NOT NULL DEFAULT true,
    username        text        NOT NULL,
    password_enc    text        NOT NULL,
    mailbox         text        NOT NULL DEFAULT 'INBOX',
    notify_channel  text        NOT NULL DEFAULT 'telegram'
        CHECK (notify_channel IN ('telegram', 'discord')),
    max_body_chars  integer     NOT NULL DEFAULT 12000 CHECK (max_body_chars BETWEEN 500 AND 100000),
    enabled         boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS imap_account_cursors (
    account_id      uuid        PRIMARY KEY REFERENCES imap_accounts (id) ON DELETE CASCADE,
    uid_validity    text        NOT NULL,
    last_uid        integer     NOT NULL CHECK (last_uid >= 0),
    initialized_at  timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS imap_account_messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      uuid        NOT NULL REFERENCES imap_accounts (id) ON DELETE CASCADE,
    uid_validity    text        NOT NULL,
    uid             integer     NOT NULL CHECK (uid > 0),
    message_id      text,
    from_address    text        NOT NULL,
    subject         text        NOT NULL,
    received_at     timestamptz NOT NULL,
    body_text       text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, uid_validity, uid)
);

CREATE INDEX IF NOT EXISTS imap_accounts_enabled_idx ON imap_accounts (id) WHERE enabled;
CREATE INDEX IF NOT EXISTS imap_account_messages_account_uid_idx
    ON imap_account_messages (account_id, uid_validity, uid DESC);
CREATE INDEX IF NOT EXISTS imap_account_messages_created_idx
    ON imap_account_messages (created_at DESC);
