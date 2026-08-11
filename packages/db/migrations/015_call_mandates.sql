-- What the agent was authorised to agree to on a phone call, decided BEFORE it
-- dialled.
--
-- The problem this solves: an appointment agreed on the phone is a commitment
-- in a stranger's booking system — not reversible, not visible to us. If the
-- agreed time came out of the transcript, then a stranger's speech (via STT,
-- via a model) would determine a calendar write. That is the same untrusted
-- path the calendar consent gate exists to close.
--
-- So the far end never supplies a value. It only ever SELECTS one from a set
-- computed from the owner's own free time and frozen here before the call. The
-- worst a misheard sentence can do is pick the wrong one of the owner's own
-- free slots — which step 8 of the resolution then re-verifies.
CREATE TABLE IF NOT EXISTS call_mandates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    call_log_id     uuid        NOT NULL REFERENCES call_logs (id) ON DELETE CASCADE,
    contact_id      uuid        REFERENCES contacts (id) ON DELETE SET NULL,

    -- The errand in the owner's own words. Shapes the opening sentence only —
    -- it grants nothing. Everything the agent may *cause* is below, so a
    -- rephrasing cannot widen what may be agreed.
    errand          text        NOT NULL,

    -- The closed set: [{id, startsAt, endsAt}]. NULL means the agent may ask
    -- but may agree to nothing at all.
    candidate_slots jsonb,
    duration_minutes integer,

    -- Past this the mandate is dead, so a call file that sits in the spool
    -- cannot be resolved into an appointment days later.
    expires_at      timestamptz NOT NULL,

    state           text        NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','agreed','recorded','declined','unresolved','failed','expired')),
    -- Always one of candidate_slots, never a value read out of the transcript.
    agreed_slot_id  text,
    -- Set once the appointment actually exists in the owner's calendar. Its
    -- absence on an `agreed` mandate is the drift case: a commitment exists out
    -- there and the owner does not know about it.
    event_uid       text,
    resolution_note text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One mandate per call. The call is the thing that was authorised.
CREATE UNIQUE INDEX IF NOT EXISTS call_mandates_call_idx ON call_mandates (call_log_id);
CREATE INDEX IF NOT EXISTS call_mandates_open_idx
    ON call_mandates (expires_at) WHERE state IN ('pending', 'agreed');

-- The transcript of a call, filled turn by turn while it runs.
--
-- `call_logs.transcript` has existed since 001 and was never written. It is the
-- audit trail for a commitment made in the owner's name, so it is the one part
-- of this that must not be optional.
COMMENT ON COLUMN call_logs.transcript IS
    'Turn-by-turn transcript: [{at, speaker: "agent"|"other", text}]. Personal data of a third party — needs a retention limit.';
