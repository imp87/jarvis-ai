"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { api } from "@/lib/api";
import { attempt } from "@/lib/attempt";
import type { ActionResult } from "@/lib/action-result";
import { SESSION_COOKIE, isCorrectPassword, issueSessionToken } from "@/lib/session";

// --- Session ---------------------------------------------------------------

/**
 * Login attempts are counted in memory. This sits behind a loopback port and a
 * reverse proxy, so it is not the primary defence — it exists so a password
 * that turns out to be weaker than intended cannot be ground down in seconds.
 * A restart clears it, which is an acceptable trade for holding no state.
 */
const attempts = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 5 * 60_000;

export async function login(_state: ActionResult, formData: FormData): Promise<ActionResult> {
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  // One bucket: this is a single-operator tool, and keying on a client IP that
  // the proxy controls would only make the limit easier to sidestep.
  const bucket = attempts.get("global") ?? { count: 0, until: 0 };
  if (bucket.until > Date.now()) {
    const seconds = Math.ceil((bucket.until - Date.now()) / 1000);
    return { error: `Too many attempts. Try again in ${seconds}s.` };
  }

  if (!(await isCorrectPassword(password))) {
    bucket.count += 1;
    if (bucket.count >= MAX_ATTEMPTS) {
      attempts.set("global", { count: 0, until: Date.now() + LOCKOUT_MS });
    } else {
      attempts.set("global", bucket);
    }
    return { error: "Wrong password." };
  }

  attempts.delete("global");
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

// --- MCP servers -----------------------------------------------------------

/**
 * Secrets are entered as `KEY=value` lines — HTTP headers for an http server,
 * environment variables for a stdio one. A textarea beats a repeating key/value
 * widget here because the values are usually pasted straight from a provider's
 * setup page in exactly this shape.
 */
function parseSecrets(raw: string): Record<string, string> | undefined {
  const entries = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator <= 0) throw new Error(`Not a KEY=value line: "${line.slice(0, 40)}"`);
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Shell-ish splitting so `--root "/some path"` survives being typed as one line. */
function parseArgs(raw: string): string[] {
  return (raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
    /^["']/.test(token) ? token.slice(1, -1) : token,
  );
}

const mcpFormSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w-]+$/, "letters, digits, _ and - only"),
    description: z.string().max(1000),
    transport: z.enum(["stdio", "http"]),
    url: z.string().url().optional(),
    command: z.string().max(500).optional(),
    args: z.array(z.string()),
    secrets: z.record(z.string()).optional(),
  })
  .refine((v) => v.transport !== "http" || Boolean(v.url), {
    message: "a URL is required for the http transport",
    path: ["url"],
  })
  .refine((v) => v.transport !== "stdio" || Boolean(v.command), {
    message: "a command is required for the stdio transport",
    path: ["command"],
  });

export async function createMcpServer(
  _state: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return attempt("Server registered.", async () => {
    const transport = String(formData.get("transport") ?? "stdio");
    const input = mcpFormSchema.parse({
      name: String(formData.get("name") ?? "").trim(),
      description: String(formData.get("description") ?? "").trim(),
      transport,
      url: transport === "http" ? String(formData.get("url") ?? "").trim() || undefined : undefined,
      command:
        transport === "stdio"
          ? String(formData.get("command") ?? "").trim() || undefined
          : undefined,
      args: transport === "stdio" ? parseArgs(String(formData.get("args") ?? "")) : [],
      secrets: parseSecrets(String(formData.get("secrets") ?? "")),
    });

    const result = await api.post<{ name: string; connected: boolean; connectError?: string }>(
      "/v1/mcp/servers",
      input,
    );
    revalidatePath("/mcp");
    revalidatePath("/");

    // Registration succeeding while the connection fails is the common case and
    // the whole reason this UI exists — say so instead of a bare "created".
    return result.connected
      ? `${result.name} registered and connected.`
      : `${result.name} registered, but connecting failed: ${result.connectError ?? "unknown error"}`;
  }, formData);
}

export async function setMcpServerEnabled(
  _state: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return attempt("Updated.", async () => {
    const id = z.string().uuid().parse(formData.get("id"));
    const enabled = formData.get("enabled") === "true";
    const result = await api.patch<{ connected: boolean; connectError?: string }>(
      `/v1/mcp/servers/${id}`,
      { enabled },
    );
    revalidatePath("/mcp");
    revalidatePath("/");
    if (!enabled) return "Server disabled.";
    return result.connected
      ? "Server enabled and connected."
      : `Enabled, but connecting failed: ${result.connectError ?? "unknown error"}`;
  });
}

export async function deleteMcpServer(
  _state: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return attempt("Server removed.", async () => {
    const id = z.string().uuid().parse(formData.get("id"));
    await api.delete(`/v1/mcp/servers/${id}`);
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
    return `${result.servers.length} server(s) connected, ${tools} tool(s) available.`;
  });
}

// --- Connectors ------------------------------------------------------------

const connectorFormSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w -]+$/, "letters, digits, spaces, _ and - only"),
    description: z.string().min(10, "at least 10 characters — the model matches on this").max(2000),
    baseUrl: z.string().url(),
    authType: z.enum(["none", "api_key_header", "bearer", "basic", "query_param"]),
    authParamName: z.string().max(64).optional(),
    credential: z.string().min(1).optional(),
  })
  .refine((v) => v.authType === "none" || Boolean(v.credential), {
    message: "a credential is required unless the auth type is 'none'",
    path: ["credential"],
  })
  .refine(
    (v) => !["api_key_header", "query_param"].includes(v.authType) || Boolean(v.authParamName),
    { message: "a parameter name is required for this auth type", path: ["authParamName"] },
  );

export async function createConnector(
  _state: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return attempt("Connector created.", async () => {
    const input = connectorFormSchema.parse({
      name: String(formData.get("name") ?? "").trim(),
      description: String(formData.get("description") ?? "").trim(),
      baseUrl: String(formData.get("baseUrl") ?? "").trim(),
      authType: String(formData.get("authType") ?? "none"),
      authParamName: String(formData.get("authParamName") ?? "").trim() || undefined,
      credential: String(formData.get("credential") ?? "") || undefined,
    });
    const result = await api.post<{ name: string }>("/v1/connectors", input);
    revalidatePath("/connectors");
    return `${result.name} created. Add at least one endpoint to make it usable.`;
  }, formData);
}

export async function setConnectorEnabled(
  _state: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return attempt("Updated.", async () => {
    const id = z.string().uuid().parse(formData.get("id"));
    await api.patch(`/v1/connectors/${id}`, { enabled: formData.get("enabled") === "true" });
    revalidatePath("/connectors");
    revalidatePath(`/connectors/${id}`);
  });
}

export async function deleteConnector(
  _state: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const id = z.string().uuid().parse(formData.get("id"));
  const result = await attempt("Connector removed.", async () => {
    await api.delete(`/v1/connectors/${id}`);
    revalidatePath("/connectors");
  });
  // The detail page for a deleted connector would 404 on refresh.
  if (result.success) redirect("/connectors");
  return result;
}

const endpointFormSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\w-]+$/, "letters, digits, _ and - only"),
  description: z.string().min(10, "at least 10 characters — this is what the model reads").max(1000),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1).max(500),
  inputSchema: z.record(z.unknown()).optional(),
  sideEffects: z.boolean(),
});

export async function createEndpoint(
  _state: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return attempt("Endpoint added.", async () => {
    const connectorId = z.string().uuid().parse(formData.get("connectorId"));
    const rawSchema = String(formData.get("inputSchema") ?? "").trim();

    let inputSchema: Record<string, unknown> | undefined;
    if (rawSchema) {
      try {
        inputSchema = JSON.parse(rawSchema) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`Input schema is not valid JSON: ${(err as Error).message}`);
      }
    }

    const input = endpointFormSchema.parse({
      name: String(formData.get("name") ?? "").trim(),
      description: String(formData.get("description") ?? "").trim(),
      method: String(formData.get("method") ?? "GET"),
      path: String(formData.get("path") ?? "").trim(),
      inputSchema,
      sideEffects: formData.get("sideEffects") === "on",
    });

    await api.post(`/v1/connectors/${connectorId}/endpoints`, input);
    revalidatePath(`/connectors/${connectorId}`);
    revalidatePath("/connectors");
  }, formData);
}

export async function deleteEndpoint(
  _state: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return attempt("Endpoint removed.", async () => {
    const id = z.string().uuid().parse(formData.get("id"));
    const connectorId = String(formData.get("connectorId") ?? "");
    await api.delete(`/v1/endpoints/${id}`);
    revalidatePath(`/connectors/${connectorId}`);
    revalidatePath("/connectors");
  });
}
