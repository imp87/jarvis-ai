import { Router } from "express";
import { z } from "zod";
import { NotFoundError, encryptSecret } from "@jarvis/shared";
import type { Container } from "../container.js";
import { asyncHandler } from "../middleware/auth.js";
import { connectRegisteredMcpServers } from "../container.js";

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
  })
  .refine((v) => v.transport !== "http" || Boolean(v.url), {
    message: "url is required for the http transport",
    path: ["url"],
  })
  .refine((v) => v.transport !== "stdio" || Boolean(v.command), {
    message: "command is required for the stdio transport",
    path: ["command"],
  });

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
  const { repos, masterKey, mcp, logger } = container;

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
      const connector = await repos.registry.createConnector({
        name: input.name,
        description: input.description,
        baseUrl: input.baseUrl,
        authType: input.authType,
        authParamName: input.authParamName ?? null,
        credentialsEnc: input.credential ? encryptSecret(input.credential, masterKey) : null,
        openapiSpec: input.openapiSpec,
      });
      logger.info({ connector: connector.name }, "connector registered");
      res.status(201).json({ id: connector.id, name: connector.name });
    }),
  );

  router.post(
    "/v1/connectors/:id/endpoints",
    asyncHandler(async (req, res) => {
      const connectorId = z.string().uuid().parse(req.params["id"]);
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
      const id = z.string().uuid().parse(req.params["id"]);
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      await repos.registry.setConnectorEnabled(id, enabled);
      res.json({ id, enabled });
    }),
  );

  router.delete(
    "/v1/connectors/:id",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
      if (!(await repos.registry.deleteConnector(id))) throw new NotFoundError("connector not found");
      res.status(204).end();
    }),
  );

  router.delete(
    "/v1/endpoints/:id",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
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
        servers: rows.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          transport: row.transport,
          url: row.url,
          command: row.command,
          enabled: row.enabled,
          connected: connected.has(row.name),
          toolCount: connected.get(row.name)?.toolCount ?? 0,
        })),
      });
    }),
  );

  router.post(
    "/v1/mcp/servers",
    asyncHandler(async (req, res) => {
      const input = createMcpServerSchema.parse(req.body);
      const row = await repos.registry.createMcpServer({
        name: input.name,
        description: input.description,
        transport: input.transport,
        url: input.url ?? null,
        command: input.command ?? null,
        args: input.args,
        secretsEnc: input.secrets ? encryptSecret(JSON.stringify(input.secrets), masterKey) : null,
      });

      // Connect immediately so the tools are usable without a restart. A
      // failure here is reported but does not undo the registration.
      try {
        await mcp.connect({
          name: row.name,
          transport: row.transport,
          url: row.url,
          command: row.command,
          args: row.args,
          ...(input.secrets ? { secrets: input.secrets } : {}),
        });
        res.status(201).json({ id: row.id, name: row.name, connected: true });
      } catch (err) {
        logger.error({ server: row.name, err: String(err) }, "MCP connect failed after registration");
        res.status(201).json({
          id: row.id,
          name: row.name,
          connected: false,
          connectError: (err as Error).message,
        });
      }
    }),
  );

  router.post(
    "/v1/mcp/reload",
    asyncHandler(async (_req, res) => {
      await mcp.disconnectAll();
      await connectRegisteredMcpServers(mcp, repos.registry, masterKey, logger);
      res.json({ servers: mcp.listServers() });
    }),
  );

  router.delete(
    "/v1/mcp/servers/:id",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
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
