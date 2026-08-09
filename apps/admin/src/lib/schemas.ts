import { z } from "zod";

/**
 * The shapes the forms and the server actions agree on.
 *
 * Import-free of anything server-side on purpose: the same schema validates in
 * the browser as you type and again in the action, so the client cannot be the
 * only thing standing between a typo and the database.
 *
 * Authentication is modelled as a small set of named methods rather than "type
 * a header name and a value". Bearer, an API key in a header, an API key in a
 * query parameter and basic auth cover very nearly everything; asking someone
 * to remember that a bearer token goes in `Authorization` prefixed with the
 * word `Bearer` is making them do the computer's job. `custom` stays for the
 * rest.
 */

const identifier = z
  .string()
  .trim()
  .min(1, "required")
  .max(64)
  .regex(/^[\w-]+$/, "letters, digits, _ and - only");

// --- Authentication --------------------------------------------------------

export const AUTH_MODES = ["none", "bearer", "header", "query", "basic", "custom"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** Sensible defaults so the common case needs no typing at all. */
export const AUTH_DEFAULTS = {
  headerName: "X-API-Key",
  paramName: "api_key",
} as const;

export const authSchema = z
  .object({
    mode: z.enum(AUTH_MODES),
    /** bearer, header, query */
    token: z.string().default(""),
    /** header */
    headerName: z.string().default(AUTH_DEFAULTS.headerName),
    /** query */
    paramName: z.string().default(AUTH_DEFAULTS.paramName),
    /** basic */
    username: z.string().default(""),
    password: z.string().default(""),
    /** custom — raw `Name: value` or `Name=value` lines */
    raw: z.string().default(""),
  })
  .superRefine((auth, ctx) => {
    const require = (value: string, path: string, message: string) => {
      if (value.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
      }
    };
    switch (auth.mode) {
      case "bearer":
        require(auth.token, "token", "the token is required");
        break;
      case "header":
        require(auth.headerName, "headerName", "the header name is required");
        require(auth.token, "token", "the key is required");
        break;
      case "query":
        require(auth.paramName, "paramName", "the parameter name is required");
        require(auth.token, "token", "the key is required");
        break;
      case "basic":
        require(auth.username, "username", "the username is required");
        require(auth.password, "password", "the password is required");
        break;
      case "custom":
        require(auth.raw, "raw", "add at least one header, or choose 'none'");
        break;
      default:
        break;
    }
  });

export type AuthInput = z.infer<typeof authSchema>;

export const emptyAuth: AuthInput = {
  mode: "none",
  token: "",
  headerName: AUTH_DEFAULTS.headerName,
  paramName: AUTH_DEFAULTS.paramName,
  username: "",
  password: "",
  raw: "",
};

// --- MCP servers -----------------------------------------------------------

export const mcpServerSchema = z
  .object({
    name: identifier,
    description: z.string().trim().max(1000).default(""),
    transport: z.enum(["stdio", "http"]),
    url: z.string().trim().default(""),
    command: z.string().trim().max(500).default(""),
    /** Shell-ish; split by the action so quoted paths survive. */
    args: z.string().default(""),
    /** stdio only: `KEY=value` per line, passed to the process as its environment. */
    env: z.string().default(""),
    /** http only. A stdio server's secrets are environment variables, not headers. */
    auth: authSchema,
  })
  .superRefine((input, ctx) => {
    if (input.transport === "http") {
      const parsed = z.string().url().safeParse(input.url);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: "a full URL is required, including https://",
        });
      }
    } else if (input.command.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "a command is required",
      });
    }
  });

export type McpServerInput = z.infer<typeof mcpServerSchema>;

export const emptyMcpServer: McpServerInput = {
  name: "",
  description: "",
  transport: "stdio",
  url: "",
  command: "",
  args: "",
  env: "",
  auth: emptyAuth,
};

// --- Embedded IMAP accounts ------------------------------------------------

export const imapAccountSchema = z.object({
  userId: z.string().uuid("choose a user"),
  name: z.string().trim().min(1, "required").max(80).regex(/^[\w .-]+$/, "letters, digits, spaces, . _ and - only"),
  host: z.string().trim().min(1, "required").max(255),
  port: z.coerce.number().int().min(1).max(65_535).default(993),
  secure: z.boolean().default(true),
  username: z.string().trim().min(1, "required").max(500),
  password: z.string().default(""),
  mailbox: z.string().trim().min(1, "required").max(500).default("INBOX"),
  notifyChannel: z.enum(["telegram", "discord"]).default("telegram"),
  maxBodyChars: z.coerce.number().int().min(500).max(100_000).default(12_000),
});

export type ImapAccountInput = z.infer<typeof imapAccountSchema>;

export function emptyImapAccount(userId = ""): ImapAccountInput {
  return {
    userId, name: "", host: "", port: 993, secure: true, username: "", password: "", mailbox: "INBOX",
    notifyChannel: "telegram", maxBodyChars: 12_000,
  };
}

// --- Connectors ------------------------------------------------------------

export const connectorSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "required")
    .max(64)
    .regex(/^[\w -]+$/, "letters, digits, spaces, _ and - only"),
  description: z
    .string()
    .trim()
    .min(10, "at least 10 characters — this is what the model matches on")
    .max(2000),
  baseUrl: z.string().trim().url("a full URL is required, including https://"),
  auth: authSchema,
});

export type ConnectorInput = z.infer<typeof connectorSchema>;

export const emptyConnector: ConnectorInput = {
  name: "",
  description: "",
  baseUrl: "",
  auth: emptyAuth,
};

// --- Scheduled tasks -------------------------------------------------------

/** Matches the orchestrator's floor: anything faster is a busy loop. */
export const MIN_INTERVAL_SECONDS = 60;

export const taskSchema = z
  .object({
    userId: z.string().uuid("choose a user"),
    title: z.string().trim().min(1, "required").max(200),
    kind: z.enum(["agent", "notify"]),
    /** agent: the standing order. notify: the literal message to deliver. */
    prompt: z.string().trim().min(1, "required").max(8000),
    channel: z.string().default("telegram"),
    scheduleKind: z.enum(["interval", "cron", "once"]),
    intervalSeconds: z.coerce.number().int().min(MIN_INTERVAL_SECONDS).nullable().default(300),
    cron: z.string().trim().default(""),
    timezone: z.string().default("Europe/Berlin"),
    /** datetime-local value for a one-off. */
    runAt: z.string().default(""),
  })
  .superRefine((task, ctx) => {
    if (task.scheduleKind === "cron" && task.cron.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cron"],
        message: "a cron expression is required, e.g. 0 8 * * 1-5",
      });
    }
    if (task.scheduleKind === "once" && task.runAt.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runAt"], message: "pick a date and time" });
    }
    if (task.scheduleKind === "interval" && (task.intervalSeconds ?? 0) < MIN_INTERVAL_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intervalSeconds"],
        message: `at least ${MIN_INTERVAL_SECONDS} seconds`,
      });
    }
  });

export type TaskInput = z.infer<typeof taskSchema>;

export function emptyTask(userId: string): TaskInput {
  return {
    userId,
    title: "",
    kind: "agent",
    prompt: "",
    channel: "telegram",
    scheduleKind: "interval",
    intervalSeconds: 300,
    cron: "",
    timezone: "Europe/Berlin",
    runAt: "",
  };
}

// --- Endpoints -------------------------------------------------------------

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export const endpointSchema = z.object({
  connectorId: z.string().uuid(),
  name: identifier,
  description: z
    .string()
    .trim()
    .min(10, "at least 10 characters — the model reads this to decide when to call it")
    .max(1000),
  method: z.enum(HTTP_METHODS),
  path: z.string().trim().min(1, "required").max(500),
  /** JSON Schema as text; parsed by the action. Empty means "takes no arguments". */
  inputSchema: z.string().default(""),
  sideEffects: z.boolean().default(false),
});

export type EndpointInput = z.infer<typeof endpointSchema>;

export function emptyEndpoint(connectorId: string): EndpointInput {
  return {
    connectorId,
    name: "",
    description: "",
    method: "GET",
    path: "",
    inputSchema: "",
    sideEffects: false,
  };
}
