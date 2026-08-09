import {
  CallRepository,
  ConversationRepository,
  EmailRepository,
  IdentityRepository,
  MemoryRepository,
  RegistryRepository,
  SettingsRepository,
  TaskRepository,
  createPool,
  type McpServerRow,
  type Pool,
} from "@jarvis/db";
import { buildEmbeddingProvider, buildProviders, type LlmRouter } from "@jarvis/llm";
import { McpManager, type McpServerConfig } from "@jarvis/mcp";
import { createLogger, decryptSecret, parseMasterKey, type Logger } from "@jarvis/shared";
import type { AppConfig } from "./config.js";
import { AgentLoop } from "./agent/loop.js";
import { buildBuiltinTools } from "./agent/tools/builtin.js";
import { ToolRegistry } from "./agent/tools/registry.js";
import { CallService } from "./services/calls.js";
import { MemoryService } from "./services/memory.js";
import { PolicyService } from "./services/policy.js";
import { NotificationService } from "./services/notify.js";
import { TaskService } from "./services/tasks.js";
import { TaskRunner } from "./services/task-runner.js";
import { buildTaskTools } from "./agent/tools/tasks.js";
import { buildEmbeddedImapTools } from "./agent/tools/imap.js";
import { buildEmbeddedWebTools } from "./agent/tools/web.js";
import { ImapService } from "./services/imap.js";
import { MailDeliveryService } from "./services/mail-delivery.js";
import { SmtpService } from "./services/smtp.js";
import { McpOAuthService } from "./services/mcp-oauth.js";

export interface Container {
  config: AppConfig;
  logger: Logger;
  pool: Pool;
  masterKey: Buffer;
  repos: {
    identities: IdentityRepository;
    conversations: ConversationRepository;
    memories: MemoryRepository;
    registry: RegistryRepository;
    calls: CallRepository;
    settings: SettingsRepository;
    tasks: TaskRepository;
    emails: EmailRepository;
  };
  router: LlmRouter;
  mcp: McpManager;
  mcpOauth: McpOAuthService;
  tools: ToolRegistry;
  memory: MemoryService;
  calls: CallService;
  policy: PolicyService;
  notifications: NotificationService;
  taskService: TaskService;
  taskRunner: TaskRunner;
  imap: ImapService;
  mailDelivery: MailDeliveryService;
  smtp: SmtpService;
  agent: AgentLoop;
  shutdown(): Promise<void>;
}

export async function buildContainer(config: AppConfig): Promise<Container> {
  const { env } = config;
  const logger = createLogger("orchestrator");
  const masterKey = parseMasterKey(env.MASTER_KEY);

  const pool = createPool({ connectionString: env.DATABASE_URL });
  const repos = {
    identities: new IdentityRepository(pool),
    conversations: new ConversationRepository(pool),
    memories: new MemoryRepository(pool),
    registry: new RegistryRepository(pool),
    calls: new CallRepository(pool),
    settings: new SettingsRepository(pool),
    tasks: new TaskRepository(pool),
    emails: new EmailRepository(pool),
  };

  const { router } = buildProviders({
    routing: config.routing,
    logger,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    maxCallsPerMinute: env.MAX_LLM_CALLS_PER_MINUTE,
  });

  const embeddings = buildEmbeddingProvider({
    provider: env.EMBEDDING_PROVIDER,
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIM,
    openaiApiKey: env.OPENAI_API_KEY,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
  });

  const memory = new MemoryService(repos.memories, embeddings, logger);

  // The environment supplies the deployed defaults; runtime_settings may
  // override individual values without a restart.
  const policy = new PolicyService(repos.settings, {
    quietHours: {
      start: env.QUIET_HOURS_START,
      end: env.QUIET_HOURS_END,
      timezone: env.QUIET_HOURS_TIMEZONE,
    },
    maxCallsPerHour: env.MAX_CALLS_PER_HOUR,
    maxCallsPerDay: env.MAX_CALLS_PER_DAY,
  });

  const calls = new CallService(
    repos.calls,
    policy,
    {
      voicePipelineUrl: env.VOICE_PIPELINE_URL,
      serviceToken: env.SERVICE_TOKEN,
    },
    logger,
  );

  const mcp = new McpManager(logger);
  const mcpOauth = new McpOAuthService(
    repos.registry,
    repos.settings,
    masterKey,
    logger,
    env.MCP_OAUTH_CALLBACK_BASE_URL,
  );
  const smtp = new SmtpService(repos.emails, masterKey, logger);
  await connectRegisteredMcpServers(mcp, repos.registry, masterKey, logger, mcpOauth);
  // IMAP accounts are created in the admin UI. The MCP tools are available
  // even before the first account exists, so adding an account needs no restart.
  mcp.registerEmbeddedServer({
    name: "imap",
    description: "Your locally mirrored IMAP mail. Read-only; it never sends or changes mail.",
    tools: buildEmbeddedImapTools(repos.emails, smtp),
  });
  // Live web access. Embedded rather than a registry row: with the default
  // provider it needs no credentials, so "what is the weather" works without
  // attaching anything first.
  mcp.registerEmbeddedServer({
    name: "web",
    description:
      "The public internet: a search engine and a page reader. This is where anything current " +
      "comes from — weather, news, prices, opening hours, timetables, documentation.",
    tools: buildEmbeddedWebTools({
      provider: env.WEB_SEARCH_PROVIDER,
      braveApiKey: env.BRAVE_SEARCH_API_KEY,
      searxngUrl: env.SEARXNG_URL,
      timeoutMs: env.WEB_REQUEST_TIMEOUT_MS,
      maxBytes: env.WEB_FETCH_MAX_BYTES,
      // Leaves room for the tool's own header inside MAX_TOOL_RESULT_CHARS, so
      // a page is cut with an explanation rather than by the registry's clamp.
      maxTextChars: Math.max(500, env.MAX_TOOL_RESULT_CHARS - 1_000),
      logger,
    }),
  });

  const notifications = new NotificationService(
    repos.identities,
    { telegram: env.TELEGRAM_ADAPTER_URL },
    env.SERVICE_TOKEN,
    logger,
  );
  const taskService = new TaskService(repos.tasks);

  const builtins = [
    ...buildBuiltinTools({
      memory,
      calls,
      ownerPhoneNumber: env.OWNER_PHONE_NUMBER,
    }),
    ...buildTaskTools({ tasks: repos.tasks, taskService, notifications }),
  ];
  const tools = new ToolRegistry(
    builtins,
    mcp,
    repos.registry,
    masterKey,
    logger,
    env.MAX_TOOL_RESULT_CHARS,
  );

  const agent = new AgentLoop(router, tools, memory, repos.conversations, logger, {
    maxSteps: env.MAX_AGENT_STEPS,
    timezone: env.QUIET_HOURS_TIMEZONE,
    maxHistoryChars: env.MAX_HISTORY_CHARS,
  });

  const taskRunner = new TaskRunner(
    repos.tasks,
    repos.conversations,
    agent,
    notifications,
    logger,
    { pollIntervalMs: env.TASK_POLL_INTERVAL_MS },
  );
  const mailDelivery = new MailDeliveryService({
    emails: repos.emails,
    calls,
    callLogs: repos.calls,
    notifications,
    logger,
    ownerPhoneNumber: env.OWNER_PHONE_NUMBER,
  });
  const imap = new ImapService({
    emails: repos.emails,
    conversations: repos.conversations,
    agent,
    delivery: mailDelivery,
    logger,
    masterKey,
  });

  return {
    config,
    logger,
    pool,
    masterKey,
    repos,
    router,
    mcp,
    mcpOauth,
    tools,
    memory,
    calls,
    policy,
    notifications,
    taskService,
    taskRunner,
    imap,
    mailDelivery,
    smtp,
    agent,
    async shutdown() {
      await taskRunner.stop();
      await imap.stop();
      await mailDelivery.stop();
      await mcp.disconnectAll();
      await pool.end();
    },
  };
}

/** Turns a stored registry row into a connectable config, decrypting secrets. */
export async function toMcpServerConfig(
  row: McpServerRow,
  masterKey: Buffer,
  logger: Logger,
  mcpOauth?: McpOAuthService,
): Promise<McpServerConfig> {
  let secrets: Record<string, string> | undefined;
  if (row.secretsEnc) {
    try {
      secrets = JSON.parse(decryptSecret(row.secretsEnc, masterKey)) as Record<string, string>;
    } catch (err) {
      logger.error(
        { server: row.name, err: String(err) },
        "could not decrypt MCP secrets; connecting without them",
      );
    }
  }
  if (row.authMode === "oauth") {
    if (!mcpOauth) throw new Error(`MCP server ${row.name} uses OAuth but the OAuth service is unavailable.`);
    secrets = { ...secrets, ...(await mcpOauth.headersFor(row)) };
  }
  return {
    name: row.name,
    description: row.description,
    transport: row.transport,
    url: row.url,
    command: row.command,
    args: row.args,
    ...(secrets ? { secrets } : {}),
  };
}

/** Reads MCP servers from the registry and connects them, decrypting secrets. */
export async function connectRegisteredMcpServers(
  mcp: McpManager,
  registry: RegistryRepository,
  masterKey: Buffer,
  logger: Logger,
  mcpOauth?: McpOAuthService,
): Promise<void> {
  const rows = await registry.listMcpServers(true);
  const settled = await Promise.allSettled(
    rows.map((row) => toMcpServerConfig(row, masterKey, logger, mcpOauth)),
  );
  const configs: McpServerConfig[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") configs.push(result.value);
    else logger.warn({ server: rows[index]?.name, err: String(result.reason) }, "MCP server not connected");
  });
  await mcp.connectAll(configs);
}
