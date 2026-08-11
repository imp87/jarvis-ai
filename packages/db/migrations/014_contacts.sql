-- Who the agent is allowed to call, and under what name it knows them.
--
-- Deliberately not `memories`. That table is model-writable through
-- `memory_save`, so a number read out of a mail body would become a "contact",
-- and its retrieval is vector similarity — the right tool for "what did he say
-- about the holiday", the wrong one for a value that triggers an irreversible
-- phone call to a stranger. This one is looked up by name, exactly.
--
-- Also not `identities`: that is the opposite direction — who may reach Jarvis,
-- not who Jarvis may reach.
CREATE TABLE IF NOT EXISTS contacts (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- What the owner calls them: "Friseur", "Werkstatt", "Dr. Meier".
    -- This is what the model passes; it never passes a number.
    name         text        NOT NULL,
    -- Always E.164. Normalised on write, so "0155…", "+49155…" and "0049155…"
    -- cannot become three contacts that look identical in the UI.
    phone_e164   text        NOT NULL,
    note         text,

    -- Knowing a number is not permission to dial it. Defaults to false so a
    -- contact the agent created is inert until the owner says otherwise, and so
    -- that the first deploy can dial nobody at all.
    allow_calls  boolean     NOT NULL DEFAULT false,

    -- Set in code from which path created the row, never asserted by the model.
    -- Lets the UI show "Jarvis angelegt, noch nicht freigegeben" rather than
    -- leaving a number of unknown provenance in the list.
    created_by   text        NOT NULL DEFAULT 'user'
        CHECK (created_by IN ('user', 'agent')),

    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    -- The agent may only ever INSERT. This constraint is what makes that
    -- enforceable: on a collision the tool reports it and changes nothing.
    --
    -- It matters more than it looks. If the model could update an existing row,
    -- an injected "unsere neue Nummer lautet …" would inherit the approval
    -- already granted to that name, and the next call would go somewhere else
    -- entirely with allow_calls still true.
    UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS contacts_user_idx ON contacts (user_id, name);
-- Serves the "may this be dialled" lookup.
CREATE INDEX IF NOT EXISTS contacts_callable_idx
    ON contacts (user_id) WHERE allow_calls;
