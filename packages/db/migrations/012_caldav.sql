-- CalDAV accounts deliberately mirror the IMAP account model: the password uses
-- the same AES-GCM envelope, so one iCloud app-specific password serves both
-- and no OAuth callback is involved.
--
-- Events are NOT mirrored. A calendar question is a time-range query, and a
-- live REPORT is always fresh — mirroring would buy nothing here and cost a
-- sync-token state machine. Only the discovered collections are cached, because
-- re-running discovery on every question would be three extra round trips.

CREATE TABLE IF NOT EXISTS caldav_accounts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name            text        NOT NULL,
    -- Either a server root ("https://caldav.icloud.com") or an already-known
    -- principal or calendar-home URL. Discovery copes with all three.
    base_url        text        NOT NULL,
    username        text        NOT NULL,
    password_enc    text        NOT NULL,
    -- The zone the user's day is rendered in. Kept per account rather than
    -- borrowed from QUIET_HOURS_TIMEZONE, which is a call-policy setting that
    -- happens to be reused as a global clock elsewhere.
    timezone        text        NOT NULL DEFAULT 'Europe/Berlin',
    enabled         boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS caldav_calendars (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      uuid        NOT NULL REFERENCES caldav_accounts (id) ON DELETE CASCADE,
    url             text        NOT NULL,
    display_name    text        NOT NULL,
    -- Collection change tag. Unused by the read-only tools; stored now so the
    -- later proactive poller can ask "did anything change" without a diff.
    ctag            text,
    color           text,
    read_only       boolean     NOT NULL DEFAULT false,
    -- A calendar home also holds VTODO-only and VJOURNAL-only collections.
    -- Recording what a collection supports keeps them out of event queries.
    supports_events boolean     NOT NULL DEFAULT true,
    -- Lets the user hide a noisy shared calendar without deleting the account.
    enabled         boolean     NOT NULL DEFAULT true,
    discovered_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, url)
);

CREATE INDEX IF NOT EXISTS caldav_accounts_enabled_idx ON caldav_accounts (id) WHERE enabled;
CREATE INDEX IF NOT EXISTS caldav_calendars_account_idx ON caldav_calendars (account_id);
