import type pg from "pg";

export type AuthType = "none" | "api_key_header" | "bearer" | "basic" | "query_param";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ConnectorRow {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  authType: AuthType;
  authParamName: string | null;
  /** Encrypted envelope. Decrypt only at call time; never return over the API. */
  credentialsEnc: string | null;
  enabled: boolean;
}

export interface ConnectorEndpointRow {
  id: string;
  connectorId: string;
  name: string;
  description: string;
  method: HttpMethod;
  path: string;
  inputSchema: Record<string, unknown>;
  sideEffects: boolean;
  enabled: boolean;
}

export interface McpServerRow {
  id: string;
  name: string;
  description: string;
  transport: "stdio" | "http";
  url: string | null;
  command: string | null;
  args: string[];
  secretsEnc: string | null;
  enabled: boolean;
}

export class RegistryRepository {
  constructor(private readonly pool: pg.Pool) {}

  // --- Connectors ----------------------------------------------------------

  async listConnectors(onlyEnabled = false): Promise<ConnectorRow[]> {
    const { rows } = await this.pool.query<Record<string, never>>(
      `SELECT id, name, description, base_url, auth_type, auth_param_name,
              credentials_enc, enabled
         FROM connectors
        WHERE ($1::boolean = false OR enabled = true)
        ORDER BY name`,
      [onlyEnabled],
    );
    return (rows as unknown as Array<Record<string, unknown>>).map(mapConnector);
  }

  async getConnector(id: string): Promise<ConnectorRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id, name, description, base_url, auth_type, auth_param_name,
              credentials_enc, enabled
         FROM connectors WHERE id = $1`,
      [id],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapConnector(row) : null;
  }

  async createConnector(input: {
    name: string;
    description: string;
    baseUrl: string;
    authType: AuthType;
    authParamName?: string | null;
    credentialsEnc?: string | null;
    openapiSpec?: unknown;
  }): Promise<ConnectorRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO connectors
         (name, description, base_url, auth_type, auth_param_name, credentials_enc, openapi_spec)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id, name, description, base_url, auth_type, auth_param_name,
                 credentials_enc, enabled`,
      [
        input.name,
        input.description,
        input.baseUrl,
        input.authType,
        input.authParamName ?? null,
        input.credentialsEnc ?? null,
        input.openapiSpec ? JSON.stringify(input.openapiSpec) : null,
      ],
    );
    return mapConnector(rows[0] as Record<string, unknown>);
  }

  async setConnectorEnabled(id: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE connectors SET enabled = $2, updated_at = now() WHERE id = $1`,
      [id, enabled],
    );
  }

  async deleteConnector(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM connectors WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  // --- Endpoints -----------------------------------------------------------

  async listEndpoints(connectorId?: string): Promise<ConnectorEndpointRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id, connector_id, name, description, method, path, input_schema,
              side_effects, enabled
         FROM connector_endpoints
        WHERE ($1::uuid IS NULL OR connector_id = $1)
        ORDER BY name`,
      [connectorId ?? null],
    );
    return (rows as Array<Record<string, unknown>>).map(mapEndpoint);
  }

  /** Enabled endpoints joined with their connector — what the tool layer needs. */
  async listCallableEndpoints(): Promise<
    Array<{ connector: ConnectorRow; endpoint: ConnectorEndpointRow }>
  > {
    const { rows } = await this.pool.query(
      `SELECT c.id AS c_id, c.name AS c_name, c.description AS c_description,
              c.base_url, c.auth_type, c.auth_param_name, c.credentials_enc,
              c.enabled AS c_enabled,
              e.id, e.connector_id, e.name, e.description, e.method, e.path,
              e.input_schema, e.side_effects, e.enabled
         FROM connector_endpoints e
         JOIN connectors c ON c.id = e.connector_id
        WHERE e.enabled = true AND c.enabled = true
        ORDER BY c.name, e.name`,
    );
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      connector: mapConnector({
        id: r["c_id"],
        name: r["c_name"],
        description: r["c_description"],
        base_url: r["base_url"],
        auth_type: r["auth_type"],
        auth_param_name: r["auth_param_name"],
        credentials_enc: r["credentials_enc"],
        enabled: r["c_enabled"],
      }),
      endpoint: mapEndpoint(r),
    }));
  }

  async createEndpoint(input: {
    connectorId: string;
    name: string;
    description: string;
    method: HttpMethod;
    path: string;
    inputSchema?: Record<string, unknown>;
    sideEffects?: boolean;
  }): Promise<ConnectorEndpointRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO connector_endpoints
         (connector_id, name, description, method, path, input_schema, side_effects)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING id, connector_id, name, description, method, path, input_schema,
                 side_effects, enabled`,
      [
        input.connectorId,
        input.name,
        input.description,
        input.method,
        input.path,
        JSON.stringify(input.inputSchema ?? { type: "object", properties: {} }),
        input.sideEffects ?? input.method !== "GET",
      ],
    );
    return mapEndpoint(rows[0] as Record<string, unknown>);
  }

  async deleteEndpoint(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM connector_endpoints WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  // --- MCP servers ---------------------------------------------------------

  async listMcpServers(onlyEnabled = false): Promise<McpServerRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id, name, description, transport, url, command, args, secrets_enc, enabled
         FROM mcp_servers
        WHERE ($1::boolean = false OR enabled = true)
        ORDER BY name`,
      [onlyEnabled],
    );
    return (rows as Array<Record<string, unknown>>).map(mapMcpServer);
  }

  async createMcpServer(input: {
    name: string;
    description?: string;
    transport: "stdio" | "http";
    url?: string | null;
    command?: string | null;
    args?: string[];
    secretsEnc?: string | null;
  }): Promise<McpServerRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO mcp_servers (name, description, transport, url, command, args, secrets_enc)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING id, name, description, transport, url, command, args, secrets_enc, enabled`,
      [
        input.name,
        input.description ?? "",
        input.transport,
        input.url ?? null,
        input.command ?? null,
        JSON.stringify(input.args ?? []),
        input.secretsEnc ?? null,
      ],
    );
    return mapMcpServer(rows[0] as Record<string, unknown>);
  }

  async getMcpServer(id: string): Promise<McpServerRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id, name, description, transport, url, command, args, secrets_enc, enabled
         FROM mcp_servers WHERE id = $1`,
      [id],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapMcpServer(row) : null;
  }

  async setMcpServerEnabled(id: string, enabled: boolean): Promise<void> {
    await this.pool.query(`UPDATE mcp_servers SET enabled = $2 WHERE id = $1`, [id, enabled]);
  }

  /**
   * Partial update. `undefined` leaves a column alone; `secretsEnc: null`
   * clears the stored credential, which is why it cannot simply be coalesced —
   * "not supplied" and "remove it" are different intents and a form that
   * re-submits without touching the credential must not wipe it.
   */
  async updateMcpServer(
    id: string,
    patch: {
      description?: string;
      url?: string | null;
      command?: string | null;
      args?: string[];
      secretsEnc?: string | null;
    },
  ): Promise<McpServerRow | null> {
    const { rows } = await this.pool.query(
      `UPDATE mcp_servers SET
         description = COALESCE($2, description),
         url         = CASE WHEN $3::boolean THEN $4 ELSE url END,
         command     = CASE WHEN $5::boolean THEN $6 ELSE command END,
         args        = COALESCE($7::jsonb, args),
         secrets_enc = CASE WHEN $8::boolean THEN $9 ELSE secrets_enc END
       WHERE id = $1
       RETURNING id, name, description, transport, url, command, args, secrets_enc, enabled`,
      [
        id,
        patch.description ?? null,
        patch.url !== undefined,
        patch.url ?? null,
        patch.command !== undefined,
        patch.command ?? null,
        patch.args ? JSON.stringify(patch.args) : null,
        patch.secretsEnc !== undefined,
        patch.secretsEnc ?? null,
      ],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapMcpServer(row) : null;
  }

  async deleteMcpServer(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM mcp_servers WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  // --- Audit ---------------------------------------------------------------

  async logToolInvocation(input: {
    conversationId: string | null;
    toolName: string;
    source: "builtin" | "mcp" | "connector";
    arguments: Record<string, unknown>;
    ok: boolean;
    error?: string;
    durationMs: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO tool_invocations
         (conversation_id, tool_name, source, arguments, ok, error, duration_ms)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [
        input.conversationId,
        input.toolName,
        input.source,
        JSON.stringify(input.arguments),
        input.ok,
        input.error ?? null,
        Math.round(input.durationMs),
      ],
    );
  }
}

function mapConnector(r: Record<string, unknown>): ConnectorRow {
  return {
    id: r["id"] as string,
    name: r["name"] as string,
    description: r["description"] as string,
    baseUrl: r["base_url"] as string,
    authType: r["auth_type"] as AuthType,
    authParamName: (r["auth_param_name"] as string | null) ?? null,
    credentialsEnc: (r["credentials_enc"] as string | null) ?? null,
    enabled: r["enabled"] as boolean,
  };
}

function mapEndpoint(r: Record<string, unknown>): ConnectorEndpointRow {
  return {
    id: r["id"] as string,
    connectorId: r["connector_id"] as string,
    name: r["name"] as string,
    description: r["description"] as string,
    method: r["method"] as HttpMethod,
    path: r["path"] as string,
    inputSchema: r["input_schema"] as Record<string, unknown>,
    sideEffects: r["side_effects"] as boolean,
    enabled: r["enabled"] as boolean,
  };
}

function mapMcpServer(r: Record<string, unknown>): McpServerRow {
  return {
    id: r["id"] as string,
    name: r["name"] as string,
    description: r["description"] as string,
    transport: r["transport"] as "stdio" | "http",
    url: (r["url"] as string | null) ?? null,
    command: (r["command"] as string | null) ?? null,
    args: (r["args"] as string[]) ?? [],
    secretsEnc: (r["secrets_enc"] as string | null) ?? null,
    enabled: r["enabled"] as boolean,
  };
}
