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
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
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
  authMode: "static" | "oauth";
  oauthStatus: "not_connected" | "pending" | "connected" | "error";
  oauthError: string | null;
  oauthConnectedAt: string | null;
  hasOAuthClient: boolean;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  toolNames: string[];
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface McpOAuthSettings {
  callbackBaseUrl: string;
  callbackUrl: string;
  overridden: boolean;
}

export interface Contact {
  id: string;
  userId: string;
  name: string;
  phoneE164: string;
  note: string | null;
  /** Whether the agent may dial this number. Only ever set here, in the UI. */
  allowCalls: boolean;
  /** 'agent' means Jarvis saved it from something the user said. */
  createdBy: "user" | "agent";
  createdAt: string;
}

export interface ImapAccount {
  id: string;
  userId: string;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  mailbox: string;
  notifyChannel: "telegram" | "discord";
  deliveryPolicy: {
    low: "none" | "telegram" | "discord" | "call";
    normal: "none" | "telegram" | "discord" | "call";
    urgent: "none" | "telegram" | "discord" | "call";
    callFallback: "none" | "telegram" | "discord";
    callRetryCount: number;
    callRetryDelayMinutes: number;
    replyMode: "none" | "draft" | "ask";
    instructions: string;
  };
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string | null;
  smtpFrom: string | null;
  hasSmtpPassword: boolean;
  maxBodyChars: number;
  enabled: boolean;
  hasPassword: boolean;
  state: "stopped" | "connecting" | "connected" | "error";
  lastError: string | null;
}

export interface CalDavCalendar {
  id: string;
  displayName: string;
  url: string;
  color: string | null;
  readOnly: boolean;
  supportsEvents: boolean;
  enabled: boolean;
}

export interface CalDavAccount {
  id: string;
  userId: string;
  name: string;
  baseUrl: string;
  username: string;
  timezone: string;
  enabled: boolean;
  hasPassword: boolean;
  state: "stopped" | "discovering" | "ready" | "error";
  lastError: string | null;
  lastCheckedAt: string | null;
  calendars: CalDavCalendar[];
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
    outboundCallsEnabled: boolean;
  };
  callBudgetUsage: { lastHour: number; lastDay: number };
}

export interface PolicyDefaults {
  quietHours: { start: string; end: string; timezone: string };
  maxCallsPerHour: number;
  maxCallsPerDay: number;
}

export interface ResolvedPolicy extends PolicyDefaults {
  /** Which values come from the database rather than the deployed environment. */
  overridden: {
    quietHoursStart: boolean;
    quietHoursEnd: boolean;
    quietHoursTimezone: boolean;
    maxCallsPerHour: boolean;
    maxCallsPerDay: boolean;
  };
  updatedAt: string | null;
}

export interface ChannelSettings {
  channel: string;
  replyFormat: "text" | "voice";
  voiceId: string | null;
  language: string;
}

export interface AdminUser {
  id: string;
  displayName: string;
  isOwner: boolean;
  identities: Array<{
    channel: string;
    channelUserId: string;
    enabled: boolean;
    userId: string;
  }>;
  settings: ChannelSettings[];
}

export interface Task {
  id: string;
  userId: string;
  title: string;
  kind: "agent" | "notify";
  prompt: string;
  channel: string;
  profile: string | null;
  scheduleKind: "interval" | "cron" | "once";
  intervalSeconds: number | null;
  cron: string | null;
  timezone: string;
  scheduleDescription: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  enabled: boolean;
  createdBy: "user" | "agent";
  runCount: number;
  failureCount: number;
  lastStatus: string | null;
  lastError: string | null;
}

export interface TaskRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "ok" | "failed";
  summary: string | null;
  error: string | null;
  steps: number | null;
  toolCalls: string[];
  durationMs: number | null;
}

export const getMcpServers = () => api.get<{ servers: McpServer[] }>("/v1/mcp/servers");
export const getMcpOAuthSettings = () => api.get<McpOAuthSettings>("/v1/mcp/oauth/settings");
export const getTasks = () => api.get<{ tasks: Task[] }>("/v1/tasks");
export const getTaskRuns = (id: string) =>
  api.get<{ runs: TaskRun[] }>(`/v1/tasks/${id}/runs?limit=20`);
export const getPolicy = () =>
  api.get<{ policy: ResolvedPolicy; environmentDefaults: PolicyDefaults }>("/v1/settings/policy");
export const getUsers = () => api.get<{ users: AdminUser[] }>("/v1/users");
export const getConnectors = () => api.get<{ connectors: Connector[] }>("/v1/connectors");
export const getStatus = () => api.get<Status>("/v1/status");
export const getImapAccounts = () => api.get<{ accounts: ImapAccount[] }>("/v1/imap/accounts");
export const getCalDavAccounts = () => api.get<{ accounts: CalDavAccount[] }>("/v1/caldav/accounts");
export const getContacts = (userId: string) =>
  api.get<{ contacts: Contact[] }>(`/v1/contacts?userId=${encodeURIComponent(userId)}`);
