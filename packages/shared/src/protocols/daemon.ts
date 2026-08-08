import { z } from "zod";

/**
 * PC-control daemon <-> orchestrator wire protocol (component 4).
 *
 * Only the protocol is defined here; the daemon itself is a later phase. The
 * shapes live in `@jarvis/shared` so the daemon can be written in any runtime
 * that can read this schema, and so the orchestrator can validate every frame.
 *
 * Transport: the daemon dials OUT to wss://<orchestrator>/v1/daemon over TLS.
 * No inbound port is opened on the PC. Auth is a per-daemon token presented in
 * the `hello` frame and compared in constant time; mTLS is the intended
 * hardening step once the CA plumbing exists.
 *
 * Design rule: the daemon never receives free-form shell input. Every action is
 * a named capability from a server-side allowlist, so the blast radius is the
 * allowlist, not "whatever the model typed".
 */

export const DAEMON_PROTOCOL_VERSION = 1;

// --- Capabilities ----------------------------------------------------------

export const capabilitySchema = z.enum([
  /** Capture a screenshot and return it as a base64 PNG. Read-only. */
  "screen.capture",
  /** Run a named script from the daemon's local allowlist. Args are validated by the daemon. */
  "script.run",
  /** Open a file or URL with the OS default handler. */
  "shell.open",
  /** Read a file under a configured root directory. Read-only. */
  "file.read",
  /** Synthetic mouse/keyboard input. HIGH RISK — off by default. */
  "input.control",
]);
export type Capability = z.infer<typeof capabilitySchema>;

/** Capabilities that change state; these always require an approval decision. */
export const MUTATING_CAPABILITIES: readonly Capability[] = [
  "script.run",
  "shell.open",
  "input.control",
];

// --- Daemon -> server ------------------------------------------------------

export const daemonHelloSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
  daemonId: z.string().min(1),
  /** Presented once per connection; compared with timingSafeEqual server-side. */
  token: z.string().min(32),
  hostname: z.string(),
  platform: z.enum(["win32", "darwin", "linux"]),
  agentVersion: z.string(),
  /** What this daemon is willing to do, independent of what the server asks for. */
  capabilities: z.array(capabilitySchema),
});

export const daemonResultSchema = z.object({
  type: z.literal("result"),
  requestId: z.string().uuid(),
  ok: z.boolean(),
  /** Capability-specific payload. Screenshots arrive as { imageBase64, width, height }. */
  data: z.record(z.unknown()).optional(),
  error: z.string().optional(),
  durationMs: z.number().nonnegative(),
});

export const daemonHeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  /** Monotonic counter so the server can spot a restarted daemon. */
  sequence: z.number().int().nonnegative(),
});

export const daemonToServerSchema = z.discriminatedUnion("type", [
  daemonHelloSchema,
  daemonResultSchema,
  daemonHeartbeatSchema,
]);
export type DaemonToServer = z.infer<typeof daemonToServerSchema>;

// --- Server -> daemon ------------------------------------------------------

export const serverWelcomeSchema = z.object({
  type: z.literal("welcome"),
  sessionId: z.string().uuid(),
  /** Intersection of what the daemon offers and what the server policy permits. */
  grantedCapabilities: z.array(capabilitySchema),
  heartbeatIntervalMs: z.number().int().positive(),
});

export const serverRequestSchema = z.object({
  type: z.literal("request"),
  requestId: z.string().uuid(),
  capability: capabilitySchema,
  /** Validated against the capability's schema by the daemon before executing. */
  params: z.record(z.unknown()),
  /** Human-readable justification, shown in the local approval prompt. */
  reason: z.string().max(500),
  /**
   * Approval mode, decided server-side by the policy layer:
   *   auto    - execute immediately (read-only capabilities only)
   *   confirm - daemon shows a local prompt and waits for the human
   *   plan    - do not execute; return what *would* happen
   */
  approval: z.enum(["auto", "confirm", "plan"]),
  timeoutMs: z.number().int().positive().max(120_000).default(30_000),
});

export const serverErrorSchema = z.object({
  type: z.literal("error"),
  code: z.enum([
    "unauthorized",
    "protocol_version_mismatch",
    "capability_denied",
    "rate_limited",
    "internal",
  ]),
  message: z.string(),
  /** When set, the daemon must not reconnect before this many seconds pass. */
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});

export const serverToDaemonSchema = z.discriminatedUnion("type", [
  serverWelcomeSchema,
  serverRequestSchema,
  serverErrorSchema,
]);
export type ServerToDaemon = z.infer<typeof serverToDaemonSchema>;
