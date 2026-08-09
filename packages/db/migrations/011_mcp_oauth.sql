-- OAuth state for remote MCP servers. Secrets are AES-GCM envelopes, just
-- like the existing MCP headers; browser redirects contain only an opaque,
-- short-lived state value.

ALTER TABLE runtime_settings
  ADD COLUMN IF NOT EXISTS mcp_oauth_callback_base_url text;

ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS auth_mode text NOT NULL DEFAULT 'static'
    CHECK (auth_mode IN ('static', 'oauth')),
  ADD COLUMN IF NOT EXISTS oauth_config_enc text,
  ADD COLUMN IF NOT EXISTS oauth_tokens_enc text,
  ADD COLUMN IF NOT EXISTS oauth_status text NOT NULL DEFAULT 'not_connected'
    CHECK (oauth_status IN ('not_connected', 'pending', 'connected', 'error')),
  ADD COLUMN IF NOT EXISTS oauth_error text,
  ADD COLUMN IF NOT EXISTS oauth_connected_at timestamptz;

CREATE TABLE IF NOT EXISTS mcp_oauth_sessions (
  state                 text PRIMARY KEY,
  mcp_server_id         uuid        NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
  code_verifier_enc     text        NOT NULL,
  authorization_server  text        NOT NULL,
  authorization_endpoint text       NOT NULL,
  token_endpoint        text        NOT NULL,
  client_id             text        NOT NULL,
  client_secret_enc     text,
  redirect_uri          text        NOT NULL,
  resource_uri          text        NOT NULL,
  expires_at            timestamptz NOT NULL,
  used_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_oauth_sessions_expires_idx
  ON mcp_oauth_sessions (expires_at);
