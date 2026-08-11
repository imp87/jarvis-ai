import { Router } from "express";
import { z } from "zod";
import type { McpServerRow, RegistryRepository } from "@jarvis/db";
import { AppError, NotFoundError, decryptSecret, encryptSecret } from "@jarvis/shared";
import type { Container } from "../container.js";
import { asyncHandler } from "../middleware/auth.js";
import { connectRegisteredMcpServers, toMcpServerConfig } from "../container.js";

const authTypeSchema = z.enum(["none", "api_key_header", "bearer", "basic", "query_param"]);
const methodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const createConnectorSchema = z
  .object({
    name: z.string().min(1).max(64).regex(/^[\w -]+$/, "letters, digits, spaces, _ and - only"),
    // This text is what the model matches "check Stripe" against, so it is
    // required and should describe capability, not branding.
    description: z.string().min(10).max(2000),
    baseUrl: z.string().url(),
    authType: authTypeSchema,
    authParamName: z.string().max(64).optional(),
    /** Plaintext on the way in; encrypted before it ever touches the database. */
    credential: z.string().min(1).optional(),
    openapiSpec: z.unknown().optional(),
  })
  .refine((v) => v.authType === "none" || v.credential !== undefined, {
    message: "credential is required unless authType is 'none'",
    path: ["credential"],
  })
  .refine(
    (v) => !["api_key_header", "query_param"].includes(v.authType) || Boolean(v.authParamName),
    { message: "authParamName is required for api_key_header and query_param", path: ["authParamName"] },
  );

const createEndpointSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[\w-]+$/),
  description: z.string().min(10).max(1000),
  method: methodSchema,
  path: z.string().min(1).max(500),
  inputSchema: z.record(z.unknown()).optional(),
  sideEffects: z.boolean().optional(),
});

const createMcpServerSchema = z
  .object({
    name: z.string().min(1).max(64).regex(/^[\w-]+$/),
    description: z.string().max(1000).default(""),
    transport: z.enum(["stdio", "http"]),
    url: z.string().url().optional(),
    command: z.string().max(500).optional(),
    args: z.array(z.string()).default([]),
    /** Headers (http) or env vars (stdio). Encrypted at rest. */
    secrets: z.record(z.string()).optional(),
    authMode: z.enum(["static", "oauth"]).default("static"),
    oauth: z
      .object({
        clientId: z.string().trim().max(1000).optional(),
        clientSecret: z.string().max(2000).optional(),
        scope: z.string().trim().max(2000).optional(),
      })
      .optional(),
  })
  .refine((v) => v.transport !== "http" || Boolean(v.url), {
    message: "url is required for the http transport",
    path: ["url"],
  })
  .refine((v) => v.transport !== "stdio" || Boolean(v.command), {
    message: "command is required for the stdio transport",
    path: ["command"],
  })
  .refine((v) => v.authMode !== "oauth" || v.transport === "http", {
    message: "OAuth is available only for remote HTTP MCP servers",
    path: ["authMode"],
  });

/**
 * Every field is optional and absence means "leave it alone" — except
 * `secrets: null`, which is how a credential is deliberately removed. The
 * transport and the name are not editable: both are baked into the tool names
 * the model has already seen, so changing them is a new registration.
 */
const updateMcpServerSchema = z.object({
  enabled: z.boolean().optional(),
  description: z.string().max(1000).optional(),
  url: z.string().url().optional(),
  command: z.string().max(500).optional(),
  args: z.array(z.string()).optional(),
  secrets: z.record(z.string()).nullable().optional(),
  authMode: z.enum(["static", "oauth"]).optional(),
  oauth: z
    .object({
      clientId: z.string().trim().max(1000).optional(),
      clientSecret: z.string().max(2000).optional(),
      scope: z.string().trim().max(2000).optional(),
    })
    .nullable()
    .optional(),
});

const uuidSchema = z.string().uuid();

/** A path parameter, rejected as a 400 rather than reaching the SQL. */
function pathId(value: unknown): string {
  return uuidSchema.parse(value);
}

type McpServerPatch = z.infer<typeof updateMcpServerSchema>;
type McpServerColumns = Parameters<RegistryRepository["updateMcpServer"]>[1];

/**
 * Translates a request patch into the columns to write.
 *
 * Absence and explicit null mean different things for every credential field:
 * omitting a key leaves the stored value alone, while `null` deliberately
 * clears it. Building the object key by key keeps those two apart — the UI
 * cannot show what is stored, so "untouched" must never be read as "clear it".
 *
 * The OAuth client config is merged rather than replaced, because the form
 * submits only the fields that were typed and the client secret is write-only.
 */
function toMcpServerColumns(
  patch: McpServerPatch,
  existing: McpServerRow,
  masterKey: Buffer,
): McpServerColumns {
  const columns: McpServerColumns = {};
  if (patch.description !== undefined) columns.description = patch.description;
  if (patch.url !== undefined) columns.url = patch.url;
  if (patch.command !== undefined) columns.command = patch.command;
  if (patch.args !== undefined) columns.args = patch.args;
  if (patch.authMode !== undefined) columns.authMode = patch.authMode;
  if (patch.secrets !== undefined) {
    columns.secretsEnc =
      patch.secrets === null ? null : encryptSecret(JSON.stringify(patch.secrets), masterKey);
  }
  if (patch.oauth !== undefined) {
    columns.oauthConfigEnc =
      patch.oauth === null
        ? null
        : encryptSecret(
            JSON.stringify({
              ...readOAuthConfig(existing.oauthConfigEnc, masterKey),
              ...patch.oauth,
            }),
            masterKey,
          );
  }
  return columns;
}

/** The stored OAuth client config, or `{}` if it is absent or undecryptable. */
function readOAuthConfig(encrypted: string | null, masterKey: Buffer): Record<string, string> {
  if (!encrypted) return {};
  try {
    const value = JSON.parse(decryptSecret(encrypted, masterKey)) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

/**
 * Postgres reports a duplicate name as 23505. Left unhandled it surfaces as a
 * 500 with a raw constraint name, which reads like the server broke when in
 * fact the caller picked a name that is already taken.
 */
function rethrowDuplicateAs409(err: unknown, what: string, name: string): never {
  if ((err as { code?: string }).code === "23505") {
    throw new AppError(
      `${what} "${name}" already exists — delete it first or choose another name`,
      409,
      "name_taken",
    );
  }
  throw err;
}

/**
 * Tool registry API (component 8) plus MCP server management (component 3).
 * The Next.js admin UI is a client of these endpoints — the logic lives here so
 * the UI stays a thin front end.
 *
 * Credentials are write-only: they go in as plaintext over TLS, are encrypted
 * immediately, and no read path ever returns them.
 */
export function registryRoutes(container: Container): Router {
  const router = Router();
  const { repos, masterKey, mcp, mcpOauth, logger } = container;

  /**
   * Connects a server and reports the outcome instead of throwing.
   *
   * Both registration and editing treat "saved, but not reachable" as a normal
   * result rather than a failure: the stored row is exactly what the operator
   * asked for, and rolling it back would only make the next attempt guesswork.
   * The reason travels back in the response so the UI can show it — the whole
   * point of attaching the server is knowing whether it works.
   */
  async function connectAndReport(
    row: McpServerRow,
    context: string,
  ): Promise<{ connected: boolean; connectError?: string }> {
    try {
      await mcp.connect(await toMcpServerConfig(row, masterKey, logger, mcpOauth));
      return { connected: true };
    } catch (err) {
      logger.error({ server: row.name, err: String(err) }, `MCP connect failed after ${context}`);
      return { connected: false, connectError: (err as Error).message };
    }
  }

  // --- Connectors ----------------------------------------------------------

  router.get(
    "/v1/connectors",
    asyncHandler(async (_req, res) => {
      const connectors = await repos.registry.listConnectors();
      const endpoints = await repos.registry.listEndpoints();
      res.json({
        connectors: connectors.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          baseUrl: c.baseUrl,
          authType: c.authType,
          authParamName: c.authParamName,
          // Presence only. The value never leaves the server.
          hasCredential: Boolean(c.credentialsEnc),
          enabled: c.enabled,
          endpoints: endpoints
            .filter((e) => e.connectorId === c.id)
            .map(({ id, name, description, method, path, sideEffects, enabled }) => ({
              id,
              name,
              description,
              method,
              path,
              sideEffects,
              enabled,
            })),
        })),
      });
    }),
  );

  router.post(
    "/v1/connectors",
    asyncHandler(async (req, res) => {
      const input = createConnectorSchema.parse(req.body);
      const connector = await repos.registry
        .createConnector({
        name: input.name,
        description: input.description,
        baseUrl: input.baseUrl,
        authType: input.authType,
        authParamName: input.authParamName ?? null,
        credentialsEnc: input.credential ? encryptSecret(input.credential, masterKey) : null,
          openapiSpec: input.openapiSpec,
        })
        .catch((err: unknown) => rethrowDuplicateAs409(err, "connector", input.name));
      logger.info({ connector: connector.name }, "connector registered");
      res.status(201).json({ id: connector.id, name: connector.name });
    }),
  );

  router.post(
    "/v1/connectors/:id/endpoints",
    asyncHandler(async (req, res) => {
      const connectorId = pathId(req.params["id"]);
      const connector = await repos.registry.getConnector(connectorId);
      if (!connector) throw new NotFoundError("connector not found");

      const input = createEndpointSchema.parse(req.body);
      const endpoint = await repos.registry.createEndpoint({
        connectorId,
        name: input.name,
        description: input.description,
        method: input.method,
        path: input.path,
        ...(input.inputSchema ? { inputSchema: input.inputSchema } : {}),
        ...(input.sideEffects !== undefined ? { sideEffects: input.sideEffects } : {}),
      });
      res.status(201).json({ id: endpoint.id, name: endpoint.name });
    }),
  );

  router.patch(
    "/v1/connectors/:id",
    asyncHandler(async (req, res) => {
      const id = pathId(req.params["id"]);
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      await repos.registry.setConnectorEnabled(id, enabled);
      res.json({ id, enabled });
    }),
  );

  router.delete(
    "/v1/connectors/:id",
    asyncHandler(async (req, res) => {
      const id = pathId(req.params["id"]);
      if (!(await repos.registry.deleteConnector(id))) throw new NotFoundError("connector not found");
      res.status(204).end();
    }),
  );

  router.delete(
    "/v1/endpoints/:id",
    asyncHandler(async (req, res) => {
      const id = pathId(req.params["id"]);
      if (!(await repos.registry.deleteEndpoint(id))) throw new NotFoundError("endpoint not found");
      res.status(204).end();
    }),
  );

  // --- MCP servers ---------------------------------------------------------

  router.get(
    "/v1/mcp/servers",
    asyncHandler(async (_req, res) => {
      const rows = await repos.registry.listMcpServers();
      const connected = new Map(mcp.listServers().map((s) => [s.name, s]));
      res.json({
        servers: rows.map((row) => {
          const failure = mcp.lastError(row.name);
          return {
            id: row.id,
            name: row.name,
            description: row.description,
            transport: row.transport,
            url: row.url,
            command: row.command,
            args: row.args,
            hasSecrets: Boolean(row.secretsEnc),
            authMode: row.authMode,
            oauthStatus: row.oauthStatus,
            oauthError: row.oauthError,
            oauthConnectedAt: row.oauthConnectedAt?.toISOString() ?? null,
            hasOAuthClient: Boolean(row.oauthConfigEnc),
            enabled: row.enabled,
            connected: connected.has(row.name),
            toolCount: connected.get(row.name)?.toolCount ?? 0,
            toolNames: mcp.toolNamesFor(row.name),
            // Why it is not connected, when it failed rather than being off.
            lastError: failure?.error ?? null,
            lastErrorAt: failure ? new Date(failure.at).toISOString() : null,
          };
        }),
      });
    }),
  );

  router.post(
    "/v1/mcp/servers",
    asyncHandler(async (req, res) => {
      const input = createMcpServerSchema.parse(req.body);
      const row = await repos.registry
        .createMcpServer({
        name: input.name,
        description: input.description,
        transport: input.transport,
        url: input.url ?? null,
        command: input.command ?? null,
        args: input.args,
          secretsEnc: input.secrets ? encryptSecret(JSON.stringify(input.secrets), masterKey) : null,
          authMode: input.authMode,
          oauthConfigEnc:
            input.authMode === "oauth"
              ? encryptSecret(JSON.stringify(input.oauth ?? {}), masterKey)
              : null,
        })
        .catch((err: unknown) => rethrowDuplicateAs409(err, "MCP server", input.name));

      // Connect immediately so the tools are usable without a restart. A
      // failure here is reported but does not undo the registration.
      const outcome = await connectAndReport(row, "registration");
      res.status(201).json({ id: row.id, name: row.name, ...outcome });
    }),
  );

  /**
   * Update a server in place: enable or disable it, correct its URL or command,
   * replace its credential.
   *
   * Editing exists because getting a credential right takes more than one
   * attempt, and the alternative — delete and re-register — throws away the
   * whole configuration to change one token.
   *
   * Every accepted change reconnects, so the response says whether the edit
   * actually fixed anything. A connect failure is reported but never rolls the
   * row back: the stored configuration is what you just asked for, and hiding
   * it would only make the next attempt guesswork.
   */
  router.patch(
    "/v1/mcp/servers/:id",
    asyncHandler(async (req, res) => {
      const id = pathId(req.params["id"]);
      const patch = updateMcpServerSchema.parse(req.body);
      const existing = await repos.registry.getMcpServer(id);
      if (!existing) throw new NotFoundError("mcp server not found");

      if (patch.enabled !== undefined) {
        await repos.registry.setMcpServerEnabled(id, patch.enabled);
      }

      let row =
        (await repos.registry.updateMcpServer(id, toMcpServerColumns(patch, existing, masterKey))) ??
        existing;

      // A new URL is a different provider as far as OAuth is concerned, so the
      // tokens issued for the old one are discarded rather than replayed.
      if (patch.url !== undefined && row.authMode === "oauth") {
        await repos.registry.setMcpOAuthState(row.id, { tokensEnc: null, status: "not_connected", error: null });
        row = (await repos.registry.getMcpServer(id)) ?? row;
      }

      const enabled = patch.enabled ?? row.enabled;
      if (!enabled) {
        await mcp.disconnect(row.name);
        return res.json({ id, enabled, connected: false });
      }
      return res.json({ id, enabled, ...(await connectAndReport({ ...row, enabled }, "update")) });
    }),
  );

  router.post(
    "/v1/mcp/reload",
    asyncHandler(async (_req, res) => {
      await mcp.disconnectAll();
      await connectRegisteredMcpServers(mcp, repos.registry, masterKey, logger, mcpOauth);
      res.json({ servers: mcp.listServers() });
    }),
  );

  router.get(
    "/v1/mcp/oauth/settings",
    asyncHandler(async (_req, res) => {
      res.json(await mcpOauth.callbackSettings());
    }),
  );

  router.put(
    "/v1/mcp/oauth/settings",
    asyncHandler(async (req, res) => {
      const input = z.object({ callbackBaseUrl: z.string().url().nullable() }).parse(req.body);
      res.json(await mcpOauth.updateCallbackBaseUrl(input.callbackBaseUrl));
    }),
  );

  router.post(
    "/v1/mcp/servers/:id/oauth/start",
    asyncHandler(async (req, res) => {
      const id = pathId(req.params["id"]);
      const server = await repos.registry.getMcpServer(id);
      if (!server) throw new NotFoundError("mcp server not found");
      res.json(await mcpOauth.start(server));
    }),
  );

  router.get(
    "/v1/mcp/oauth/callback",
    asyncHandler(async (req, res) => {
      const input = z.object({
        state: z.string().min(20).max(300),
        code: z.string().min(1).max(10_000).optional(),
        error: z.string().max(500).optional(),
        error_description: z.string().max(2000).optional(),
      }).parse(req.query);
      const completed = await mcpOauth.complete({
        state: input.state,
        code: input.code,
        error: input.error,
        errorDescription: input.error_description,
      });
      const server = await repos.registry.getMcpServer(completed.serverId);
      if (server?.enabled) {
        await mcp.disconnect(server.name);
        await mcp.connect(await toMcpServerConfig(server, masterKey, logger, mcpOauth));
      }
      res.json({ ok: true, ...completed });
    }),
  );

  router.delete(
    "/v1/mcp/servers/:id",
    asyncHandler(async (req, res) => {
      const id = pathId(req.params["id"]);
      const rows = await repos.registry.listMcpServers();
      const row = rows.find((r) => r.id === id);
      if (!row) throw new NotFoundError("mcp server not found");
      await mcp.disconnect(row.name);
      await repos.registry.deleteMcpServer(id);
      res.status(204).end();
    }),
  );

  return router;
}
