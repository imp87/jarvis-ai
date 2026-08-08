-- Tool registry (component 8) and MCP server registry (component 3).
--
-- Credentials are stored ONLY as AES-256-GCM envelopes produced by
-- @jarvis/shared `encryptSecret`. Nothing in this schema ever holds plaintext.

CREATE TABLE IF NOT EXISTS connectors (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text        NOT NULL UNIQUE,
    -- Fed to the LLM verbatim: this is what "check Stripe" matches against, so
    -- it should read like a tool description, not like a UI label.
    description     text        NOT NULL,
    base_url        text        NOT NULL,
    auth_type       text        NOT NULL
        CHECK (auth_type IN ('none', 'api_key_header', 'bearer', 'basic', 'query_param')),
    -- Header/query parameter name for api_key_header and query_param.
    auth_param_name text,
    -- Encrypted envelope; never selected into anything user-facing.
    credentials_enc text,
    -- Optional uploaded OpenAPI spec, used to derive endpoints automatically.
    openapi_spec    jsonb,
    enabled         boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connector_endpoints (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id uuid        NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
    -- Becomes part of the tool name exposed to the model.
    name         text        NOT NULL,
    description  text        NOT NULL,
    method       text        NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
    -- Path template relative to base_url, e.g. /v1/customers/{id}
    path         text        NOT NULL,
    -- JSON Schema for the arguments the model must supply.
    input_schema jsonb       NOT NULL DEFAULT '{"type":"object","properties":{}}'::jsonb,
    -- Guard rail: anything non-GET is a side effect unless explicitly cleared.
    side_effects boolean     NOT NULL DEFAULT true,
    enabled      boolean     NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connector_id, name)
);

CREATE INDEX IF NOT EXISTS connector_endpoints_connector_idx
    ON connector_endpoints (connector_id);

CREATE TABLE IF NOT EXISTS mcp_servers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text        NOT NULL UNIQUE,
    description text        NOT NULL DEFAULT '',
    transport   text        NOT NULL CHECK (transport IN ('stdio', 'http')),
    -- transport = http
    url         text,
    -- transport = stdio
    command     text,
    args        jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- Encrypted envelope holding a JSON object of headers / env vars.
    secrets_enc text,
    enabled     boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (transport = 'http'  AND url IS NOT NULL) OR
        (transport = 'stdio' AND command IS NOT NULL)
    )
);

-- ---------------------------------------------------------------------------
-- Every tool invocation is logged. This is the audit trail for "what did the
-- agent actually do", and the input to any later spend analysis.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tool_invocations (
    id              bigserial PRIMARY KEY,
    conversation_id uuid REFERENCES conversations (id) ON DELETE CASCADE,
    tool_name       text        NOT NULL,
    source          text        NOT NULL CHECK (source IN ('builtin', 'mcp', 'connector')),
    arguments       jsonb       NOT NULL,
    ok              boolean     NOT NULL,
    error           text,
    duration_ms     integer     NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tool_invocations_created_idx
    ON tool_invocations (created_at DESC);
