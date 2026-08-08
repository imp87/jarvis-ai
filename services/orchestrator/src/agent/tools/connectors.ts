import type { ConnectorEndpointRow, ConnectorRow } from "@jarvis/db";
import { decryptSecret, type ExecutableTool, type Logger, type ToolResult } from "@jarvis/shared";

/**
 * Turns a registered connector endpoint (component 8) into a callable tool.
 * The user registers "Stripe" once in the UI; the model then sees a tool whose
 * description is the text they wrote, which is what makes "check Stripe" match.
 *
 * Credentials are decrypted here, at call time, and never leave this function.
 */

const MAX_RESPONSE_CHARS = 20_000;

export function buildConnectorTool(
  connector: ConnectorRow,
  endpoint: ConnectorEndpointRow,
  masterKey: Buffer,
  logger: Logger,
): ExecutableTool {
  const name = `connector_${sanitize(connector.name)}__${sanitize(endpoint.name)}`;

  return {
    name,
    description: `${endpoint.description}\n\n(Service: ${connector.name} — ${connector.description})`,
    inputSchema: endpoint.inputSchema,
    source: "connector",
    sideEffects: endpoint.sideEffects,

    async execute(args): Promise<ToolResult> {
      let url: URL;
      let pathTemplate = endpoint.path;
      const remaining: Record<string, unknown> = { ...args };

      // Path parameters: /v1/customers/{id} consumes `id` from the arguments.
      for (const match of endpoint.path.matchAll(/\{(\w+)\}/g)) {
        const key = match[1]!;
        const value = remaining[key];
        if (value === undefined || value === null) {
          return { content: `Missing required path parameter "${key}".`, isError: true };
        }
        pathTemplate = pathTemplate.replace(`{${key}}`, encodeURIComponent(String(value)));
        delete remaining[key];
      }

      try {
        url = new URL(pathTemplate.replace(/^\//, ""), ensureTrailingSlash(connector.baseUrl));
      } catch {
        return { content: `Connector "${connector.name}" has an invalid base URL.`, isError: true };
      }

      const headers: Record<string, string> = { accept: "application/json" };
      let body: string | undefined;

      if (endpoint.method === "GET" || endpoint.method === "DELETE") {
        for (const [key, value] of Object.entries(remaining)) {
          if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }
      } else if (Object.keys(remaining).length > 0) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(remaining);
      }

      applyAuth(connector, masterKey, headers, url);

      const started = Date.now();
      try {
        const response = await fetch(url, {
          method: endpoint.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await response.text();
        const truncated =
          text.length > MAX_RESPONSE_CHARS
            ? `${text.slice(0, MAX_RESPONSE_CHARS)}\n…[truncated, ${text.length} characters total]`
            : text;

        logger.debug(
          {
            connector: connector.name,
            endpoint: endpoint.name,
            status: response.status,
            durationMs: Date.now() - started,
          },
          "connector call",
        );

        if (!response.ok) {
          return {
            content: `HTTP ${response.status} ${response.statusText}\n${truncated}`,
            isError: true,
          };
        }
        return { content: truncated || "(empty response)" };
      } catch (err) {
        // The message may contain the URL but never the credential — auth is
        // applied to headers/params that are not echoed back here.
        return {
          content: `Request to ${connector.name} failed: ${(err as Error).message}`,
          isError: true,
        };
      }
    },
  };
}

function applyAuth(
  connector: ConnectorRow,
  masterKey: Buffer,
  headers: Record<string, string>,
  url: URL,
): void {
  if (connector.authType === "none" || !connector.credentialsEnc) return;

  const secret = decryptSecret(connector.credentialsEnc, masterKey);
  switch (connector.authType) {
    case "bearer":
      headers["authorization"] = `Bearer ${secret}`;
      break;
    case "api_key_header":
      headers[connector.authParamName ?? "x-api-key"] = secret;
      break;
    case "basic":
      // Stored as "user:password".
      headers["authorization"] = `Basic ${Buffer.from(secret, "utf8").toString("base64")}`;
      break;
    case "query_param":
      url.searchParams.set(connector.authParamName ?? "api_key", secret);
      break;
    default:
      break;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
}
