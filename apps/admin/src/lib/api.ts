import "server-only";
import { serverEnv } from "./env";

/**
 * The only place that talks to the orchestrator. `server-only` is what makes
 * "the service token never reaches the browser" a build error rather than a
 * convention: importing this from a client component fails to compile.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: Array<{ path: string; message: string }> };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const env = serverEnv();

  let response: Response;
  try {
    response = await fetch(`${env.ORCHESTRATOR_URL}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${env.SERVICE_TOKEN}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      // Registry state changes from other clients too (curl, the agent itself);
      // a cached list would show a server that is no longer there.
      cache: "no-store",
    });
  } catch (err) {
    throw new ApiError(
      `Orchestrator unreachable at ${env.ORCHESTRATOR_URL} (${String(err instanceof Error ? err.message : err)})`,
      503,
      "unreachable",
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const body: unknown = text ? safeJson(text) : undefined;

  if (!response.ok) {
    const error = (body as ErrorBody | undefined)?.error;
    throw new ApiError(
      error?.message ?? `${response.status} ${response.statusText}`,
      response.status,
      error?.code ?? "request_failed",
      error?.details,
    );
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// --- Response shapes, mirroring services/orchestrator/src/routes ------------

export interface McpServer {
  id: string;
  name: string;
  description: string;
  transport: "stdio" | "http";
  url: string | null;
  command: string | null;
  args: string[];
  hasSecrets: boolean;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  toolNames: string[];
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface ConnectorEndpoint {
  id: string;
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  sideEffects: boolean;
  enabled: boolean;
}

export interface Connector {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  authType: "none" | "api_key_header" | "bearer" | "basic" | "query_param";
  authParamName: string | null;
  hasCredential: boolean;
  enabled: boolean;
  endpoints: ConnectorEndpoint[];
}

export interface Status {
  profiles: Array<{ name: string; provider: string; model: string }>;
  mcpServers: Array<{ name: string; transport: string; toolCount: number }>;
  tools: Array<{ name: string; source: "builtin" | "mcp" | "connector"; sideEffects: boolean }>;
  policy: {
    quietHours: { start: string; end: string; timezone: string };
    maxCallsPerHour: number;
    maxCallsPerDay: number;
    maxAgentSteps: number;
  };
  callBudgetUsage: { lastHour: number; lastDay: number };
}

export const getMcpServers = () => api.get<{ servers: McpServer[] }>("/v1/mcp/servers");
export const getConnectors = () => api.get<{ connectors: Connector[] }>("/v1/connectors");
export const getStatus = () => api.get<Status>("/v1/status");
