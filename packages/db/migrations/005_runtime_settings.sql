-- Policy that is edited while the system runs, rather than at deploy time.
--
-- Everything else in this project is configured by environment variable,
-- deliberately: a missing secret should crash the process at startup instead of
-- surfacing as a 500 at 2am. That argument does not hold for quiet hours and
-- the call budget. Those are decisions about your evening, they change more
-- often than the code does, and requiring a container restart to move quiet
-- hours by an hour is the kind of friction that ends with the guard rail
-- switched off entirely.
--
-- Every column is nullable and NULL means "use the environment value". So the
-- env stays the source of truth until someone deliberately overrides a single
-- setting, and clearing an override restores the deployed default rather than
-- some second, forgotten copy of it.

CREATE TABLE IF NOT EXISTS runtime_settings (
    -- Singleton: one row, enforced by the primary key and the check together.
    id                   boolean     PRIMARY KEY DEFAULT true CHECK (id),

    -- HH:MM, local to quiet_hours_timezone. Start after end means the window
    -- wraps midnight, which is the normal case.
    quiet_hours_start    text        CHECK (quiet_hours_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    quiet_hours_end      text        CHECK (quiet_hours_end   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    quiet_hours_timezone text,

    -- 0 means unlimited, matching the environment variables these override.
    max_calls_per_hour   integer     CHECK (max_calls_per_hour >= 0),
    max_calls_per_day    integer     CHECK (max_calls_per_day  >= 0),

    updated_at           timestamptz NOT NULL DEFAULT now()
);

-- The row must exist so an UPDATE is always the operation; nothing else has to
-- know whether anyone has opened the settings page yet.
INSERT INTO runtime_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
