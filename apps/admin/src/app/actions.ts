"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { api } from "@/lib/api";
import { attempt } from "@/lib/attempt";
import { ok, warn, type ActionResult } from "@/lib/action-result";
import {
  connectorSchema,
  endpointSchema,
  mcpServerSchema,
  imapAccountSchema,
  taskSchema,
  type TaskInput,
  type AuthInput,
  type ConnectorInput,
  type EndpointInput,
  type McpServerInput,
  type ImapAccountInput,
} from "@/lib/schemas";
import { SESSION_COOKIE, isCorrectPassword, issueSessionToken } from "@/lib/session";

// --- Session ---------------------------------------------------------------

/**
 * Login attempts are counted in memory. This sits behind a loopback port and a
 * reverse proxy, so it is not the primary defence — it exists so a password
 * that turns out to be weaker than intended cannot be ground down in seconds.
 */
let attempts = { count: 0, until: 0 };
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 5 * 60_000;

export async function login(password: string, next: string): Promise<ActionResult> {
  if (attempts.until > Date.now()) {
    const seconds = Math.ceil((attempts.until - Date.now()) / 1000);
    return { status: "error", message: `Too many attempts. Try again in ${seconds}s.` };
  }

  if (!(await isCorrectPassword(password))) {
    attempts.count += 1;
    if (attempts.count >= MAX_ATTEMPTS) attempts = { count: 0, until: Date.now() + LOCKOUT_MS };
    return { status: "error", message: "Wrong password." };
  }

  attempts = { count: 0, until: 0 };
  const { value, maxAge } = await issueSessionToken();
  (await cookies()).set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    // Not `secure`: the deployment target is a loopback port behind Nginx Proxy
    // Manager, and over plain http a secure cookie is silently dropped — which
    // presents as a login that succeeds and immediately bounces back.
    path: "/",
    maxAge,
  });

  // Only ever a path on this host; an absolute URL here would be an open redirect.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

// --- Translating the auth presets -----------------------------------------

/**
 * Turns a chosen method into the HTTP headers an MCP server expects.
 *
 * Base64 is computed here rather than in the browser: `btoa` mangles anything
 * outside Latin-1, and passwords contain umlauts.
 */
function authToHeaders(auth: AuthInput): Record<string, string> | undefined {
  switch (auth.mode) {
    case "bearer":
      return { Authorization: `Bearer ${auth.token.trim()}` };
    case "header":
      return { [auth.headerName.trim()]: auth.token.trim() };
    case "basic":
      return {
        Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}`,
      };
    case "custom":
      return parseHeaderLines(auth.raw);
    case "query":
      // Not reachable from the MCP form, which does not offer it: an MCP
      // endpoint URL carries its own query string and mixing the two silently
      // is worse than not offering it.
      return undefined;
    default:
      return undefined;
  }
}

/** Maps a chosen method onto what the connector registry stores. */
function authToConnectorFields(auth: AuthInput): {
  authType: "none" | "api_key_header" | "bearer" | "basic" | "query_param";
  authParamName?: string;
  credential?: string;
} {
  switch (auth.mode) {
    case "bearer":
      return { authType: "bearer", credential: auth.token.trim() };
    case "header":
      return {
        authType: "api_key_header",
        authParamName: auth.headerName.trim(),
        credential: auth.token.trim(),
      };
    case "query":
      return {
        authType: "query_param",
        authParamName: auth.paramName.trim(),
        credential: auth.token.trim(),
      };
    case "basic":
      // The registry stores basic credentials as "user:password" and encodes
      // them at call time — see connectors.ts.
      return { authType: "basic", credential: `${auth.username}:${auth.password}` };
    default:
      return { authType: "none" };
  }
}

/** Accepts `Name: value` and `Name=value`, since both get pasted from docs. */
function parseHeaderLines(raw: string): Record<string, string> | undefined {
  const entries = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const at = line.search(/[:=]/);
      if (at <= 0) throw new Error(`Not a "Name: value" line: "${line.slice(0, 40)}"`);
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as const;
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** `KEY=value` lines for a stdio server's environment. */
function parseEnvLines(raw: string): Record<string, string> | undefined {
  const entries = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      if (at <= 0) throw new Error(`Not a KEY=value line: "${line.slice(0, 40)}"`);
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as const;
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Shell-ish splitting so `--root "/some path"` survives being typed as one line. */
function parseArgs(raw: string): string[] {
  return (raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
    /^["']/.test(token) ? token.slice(1, -1) : token,
  );
}

// --- MCP servers -----------------------------------------------------------

export async function createMcpServer(raw: McpServerInput): Promise<ActionResult> {
  return attempt("Server registered.", async () => {
    const input = mcpServerSchema.parse(raw);
    const secrets =
      input.transport === "http" ? authToHeaders(input.auth) : parseEnvLines(input.env);

    const result = await api.post<{ name: string; connected: boolean; connectError?: string }>(
      "/v1/mcp/servers",
      {
        name: input.name,
        description: input.description,
        transport: input.transport,
        ...(input.transport === "http"
          ? { url: input.url }
          : { command: input.command, args: parseArgs(input.args) }),
        ...(secrets ? { secrets } : {}),
      },
    );
    revalidatePath("/mcp");
    revalidatePath("/");

    // Registered but unreachable is the common case and must not read as
    // success — that is the whole point of attaching the server.
    return result.connected
      ? ok(`${result.name} is connected and its tools are available.`)
      : warn(
          `${result.name} was saved, but connecting failed: ${result.connectError ?? "unknown error"}`,
        );
  });
}

/**
 * Editing an existing server. The credential is only sent when one was typed —
 * an untouched password field means "keep what is stored", never "clear it",
 * because the UI cannot show what is there to begin with.
 */
export async function updateMcpServer(
  id: string,
  raw: McpServerInput,
  options: { replaceSecret: boolean },
): Promise<ActionResult> {
  return attempt("Server updated.", async () => {
    const input = mcpServerSchema.parse(raw);
    const secrets =
      input.transport === "http" ? authToHeaders(input.auth) : parseEnvLines(input.env);

    const result = await api.patch<{ connected: boolean; connectError?: string }>(
      `/v1/mcp/servers/${z.string().uuid().parse(id)}`,
      {
        description: input.description,
        ...(input.transport === "http"
          ? { url: input.url }
          : { command: input.command, args: parseArgs(input.args) }),
        ...(options.replaceSecret ? { secrets: secrets ?? null } : {}),
      },
    );
    revalidatePath("/mcp");
    revalidatePath("/");
    return result.connected
      ? ok(`${input.name} reconnected — its tools are available.`)
      : warn(`Saved, but connecting still fails: ${result.connectError ?? "unknown error"}`);
  });
}

export async function setMcpServerEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  return attempt("Updated.", async () => {
    const result = await api.patch<{ connected: boolean; connectError?: string }>(
      `/v1/mcp/servers/${z.string().uuid().parse(id)}`,
      { enabled },
    );
    revalidatePath("/mcp");
    revalidatePath("/");
    if (!enabled) return ok("Server disabled.");
    return result.connected
      ? ok("Server enabled and connected.")
      : warn(`Enabled, but connecting failed: ${result.connectError ?? "unknown error"}`);
  });
}

export async function deleteMcpServer(id: string): Promise<ActionResult> {
  return attempt("Server removed.", async () => {
    await api.delete(`/v1/mcp/servers/${z.string().uuid().parse(id)}`);
    revalidatePath("/mcp");
    revalidatePath("/");
  });
}

export async function reloadMcpServers(): Promise<ActionResult> {
  return attempt("Reloaded.", async () => {
    const result = await api.post<{ servers: Array<{ name: string; toolCount: number }> }>(
      "/v1/mcp/reload",
    );
    revalidatePath("/mcp");
    revalidatePath("/");
    const tools = result.servers.reduce((sum, s) => sum + s.toolCount, 0);
    return ok(`${result.servers.length} server(s) connected, ${tools} tool(s) available.`);
  });
}

// --- Embedded IMAP accounts ------------------------------------------------

export async function createImapAccount(raw: ImapAccountInput): Promise<ActionResult> {
  return attempt("IMAP account added.", async () => {
    const input = imapAccountSchema.parse(raw);
    if (!input.password.trim()) throw new Error("The IMAP password or app password is required.");
    const { smtpHost, smtpPort, smtpSecure, smtpUsername, smtpPassword, smtpFrom, ...account } = input;
    await api.post("/v1/imap/accounts", {
      ...account,
      // Kept for older database rows; the delivery policy is authoritative.
      notifyChannel: input.deliveryPolicy.normal === "discord" ? "discord" : "telegram",
      ...(smtpHost.trim()
        ? {
            smtpHost: smtpHost.trim(), smtpPort, smtpSecure,
            ...(smtpUsername.trim() ? { smtpUsername: smtpUsername.trim() } : {}),
            ...(smtpPassword.trim() ? { smtpPassword } : {}),
            ...(smtpFrom.trim() ? { smtpFrom: smtpFrom.trim() } : {}),
          }
        : {}),
    });
    revalidatePath("/imap");
    revalidatePath("/");
    return ok("Account saved. Jarvis is connecting via IMAP IDLE now.");
  });
}

export async function updateImapAccount(id: string, raw: ImapAccountInput): Promise<ActionResult> {
  return attempt("IMAP account updated.", async () => {
    const input = imapAccountSchema.parse(raw);
    await api.patch(`/v1/imap/accounts/${z.string().uuid().parse(id)}`, {
      name: input.name, host: input.host, port: input.port, secure: input.secure,
      username: input.username, mailbox: input.mailbox,
      notifyChannel: input.deliveryPolicy.normal === "discord" ? "discord" : "telegram",
      deliveryPolicy: input.deliveryPolicy,
      smtpHost: input.smtpHost.trim() || null,
      smtpPort: input.smtpPort,
      smtpSecure: input.smtpSecure,
      smtpUsername: input.smtpUsername.trim() || null,
      smtpFrom: input.smtpFrom.trim() || null,
      ...(input.smtpPassword.trim() ? { smtpPassword: input.smtpPassword } : {}),
      maxBodyChars: input.maxBodyChars,
      ...(input.password.trim() ? { password: input.password } : {}),
    });
    revalidatePath("/imap");
    revalidatePath("/");
    return ok("Saved. The IMAP connection is being restarted.");
  });
}

export async function setImapAccountEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  return attempt("Updated.", async () => {
    await api.patch(`/v1/imap/accounts/${z.string().uuid().parse(id)}`, { enabled });
    revalidatePath("/imap");
    revalidatePath("/");
    return ok(enabled ? "Account enabled and connecting." : "Account disabled.");
  });
}

export async function deleteImapAccount(id: string): Promise<ActionResult> {
  return attempt("IMAP account removed.", async () => {
    await api.delete(`/v1/imap/accounts/${z.string().uuid().parse(id)}`);
    revalidatePath("/imap");
    revalidatePath("/");
  });
}

// --- Global policy ---------------------------------------------------------

/**
 * `null` clears an override and hands the setting back to the environment;
 * omitting a key leaves it untouched. Keeping those apart is what makes "reset
 * to the deployed default" possible at all.
 */
const policyPatchSchema = z.object({
  quietHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM").nullable(),
  quietHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM").nullable(),
  quietHoursTimezone: z.string().min(1).max(64).nullable(),
  maxCallsPerHour: z.number().int().min(0).max(100).nullable(),
  maxCallsPerDay: z.number().int().min(0).max(500).nullable(),
});

export type PolicyPatch = z.infer<typeof policyPatchSchema>;

export async function updatePolicy(raw: PolicyPatch): Promise<ActionResult> {
  return attempt("Policy updated.", async () => {
    const patch = policyPatchSchema.parse(raw);
    await api.put("/v1/settings/policy", patch);
    revalidatePath("/settings");
    revalidatePath("/");
    return ok("Saved — it applies to the next call, no restart needed.");
  });
}

// --- Users -----------------------------------------------------------------

export async function setIdentityEnabled(
  channel: string,
  channelUserId: string,
  enabled: boolean,
): Promise<ActionResult> {
  return attempt("Updated.", async () => {
    await api.patch("/v1/identities", { channel, channelUserId, enabled });
    revalidatePath("/users");
    return ok(
      enabled
        ? "Identity enabled — this channel can reach the agent again."
        : "Identity disabled — messages from it are now rejected.",
    );
  });
}

const channelSettingsSchema = z.object({
  replyFormat: z.enum(["text", "voice"]),
  voiceId: z.string().max(128).nullable(),
  language: z.string().min(2).max(16),
});

export type ChannelSettingsPatch = z.infer<typeof channelSettingsSchema>;

export async function updateChannelSettings(
  userId: string,
  channel: string,
  raw: ChannelSettingsPatch,
): Promise<ActionResult> {
  return attempt("Settings saved.", async () => {
    const patch = channelSettingsSchema.parse(raw);
    await api.put(
      `/v1/users/${z.string().uuid().parse(userId)}/settings/${encodeURIComponent(channel)}`,
      patch,
    );
    revalidatePath("/users");
    return ok(`${channel} settings saved.`);
  });
}

// --- Scheduled tasks -------------------------------------------------------

export async function createTask(raw: TaskInput): Promise<ActionResult> {
  return attempt("Task created.", async () => {
    const input = taskSchema.parse(raw);
    const result = await api.post<{ task: { title: string; nextRunAt: string | null } }>(
      "/v1/tasks",
      {
        userId: input.userId,
        title: input.title,
        kind: input.kind,
        prompt: input.prompt,
        channel: input.channel,
        scheduleKind: input.scheduleKind,
        ...(input.scheduleKind === "interval" ? { intervalSeconds: input.intervalSeconds } : {}),
        ...(input.scheduleKind === "cron" ? { cron: input.cron } : {}),
        // `datetime-local` has no zone; the browser's own offset is the only
        // sane reading of what the person typed.
        ...(input.scheduleKind === "once" ? { runAt: new Date(input.runAt).toISOString() } : {}),
        timezone: input.timezone,
      },
    );
    revalidatePath("/tasks");
    const next = result.task.nextRunAt
      ? new Date(result.task.nextRunAt).toLocaleString("de-DE")
      : "never";
    return ok(`"${result.task.title}" scheduled — first run ${next}.`);
  });
}

export async function setTaskEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  return attempt("Updated.", async () => {
    await api.patch(`/v1/tasks/${z.string().uuid().parse(id)}`, { enabled });
    revalidatePath("/tasks");
    return ok(enabled ? "Task resumed and rescheduled." : "Task paused.");
  });
}

export async function deleteTask(id: string): Promise<ActionResult> {
  return attempt("Task deleted.", async () => {
    await api.delete(`/v1/tasks/${z.string().uuid().parse(id)}`);
    revalidatePath("/tasks");
  });
}

/** Runs a task immediately without disturbing its schedule. */
export async function runTaskNow(id: string): Promise<ActionResult> {
  return attempt("Run finished.", async () => {
    const result = await api.post<{ status: "ok" | "failed"; summary: string }>(
      `/v1/tasks/${z.string().uuid().parse(id)}/run`,
    );
    revalidatePath("/tasks");
    return result.status === "ok"
      ? ok(result.summary.slice(0, 400) || "Ran with no output.")
      : warn(`Run failed: ${result.summary}`);
  });
}

// --- Connectors ------------------------------------------------------------

export async function createConnector(raw: ConnectorInput): Promise<ActionResult> {
  return attempt("Connector created.", async () => {
    const input = connectorSchema.parse(raw);
    const result = await api.post<{ name: string }>("/v1/connectors", {
      name: input.name,
      description: input.description,
      baseUrl: input.baseUrl,
      ...authToConnectorFields(input.auth),
    });
    revalidatePath("/connectors");
    return ok(`${result.name} created. Add an endpoint to turn it into a tool.`);
  });
}

export async function setConnectorEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  return attempt("Updated.", async () => {
    const connectorId = z.string().uuid().parse(id);
    await api.patch(`/v1/connectors/${connectorId}`, { enabled });
    revalidatePath("/connectors");
    revalidatePath(`/connectors/${connectorId}`);
  });
}

export async function deleteConnector(id: string): Promise<ActionResult> {
  const connectorId = z.string().uuid().parse(id);
  const result = await attempt("Connector removed.", async () => {
    await api.delete(`/v1/connectors/${connectorId}`);
    revalidatePath("/connectors");
  });
  // The detail page for a deleted connector would 404 on refresh.
  if (result.status === "success") redirect("/connectors");
  return result;
}

export async function createEndpoint(raw: EndpointInput): Promise<ActionResult> {
  return attempt("Endpoint added.", async () => {
    const input = endpointSchema.parse(raw);

    let inputSchema: Record<string, unknown> | undefined;
    if (input.inputSchema.trim()) {
      try {
        inputSchema = JSON.parse(input.inputSchema) as Record<string, unknown>;
      } catch (err) {
        return {
          status: "error" as const,
          message: "The input schema is not valid JSON.",
          fieldErrors: { inputSchema: (err as Error).message },
        };
      }
    }

    await api.post(`/v1/connectors/${input.connectorId}/endpoints`, {
      name: input.name,
      description: input.description,
      method: input.method,
      path: input.path,
      ...(inputSchema ? { inputSchema } : {}),
      sideEffects: input.sideEffects,
    });
    revalidatePath(`/connectors/${input.connectorId}`);
    revalidatePath("/connectors");
    return ok(`${input.name} added — the agent can call it on the next turn.`);
  });
}

export async function deleteEndpoint(id: string, connectorId: string): Promise<ActionResult> {
  return attempt("Endpoint removed.", async () => {
    await api.delete(`/v1/endpoints/${z.string().uuid().parse(id)}`);
    revalidatePath(`/connectors/${connectorId}`);
    revalidatePath("/connectors");
  });
}
