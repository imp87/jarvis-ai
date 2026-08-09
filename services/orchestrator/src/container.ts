import {
  CallRepository,
  ConversationRepository,
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
  };
  router: LlmRouter;
  mcp: McpManager;
  tools: ToolRegistry;
  memory: MemoryService;
  calls: CallService;
  policy: PolicyService;
  notifications: NotificationService;
  taskService: TaskService;
  taskRunner: TaskRunner;
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
  await connectRegisteredMcpServers(mcp, repos.registry, masterKey, logger);

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

  return {
    config,
    logger,
    pool,
    masterKey,
    repos,
    router,
    mcp,
    tools,
    memory,
    calls,
    policy,
    notifications,
    taskService,
    taskRunner,
    agent,
    async shutdown() {
      await taskRunner.stop();
      await mcp.disconnectAll();
      await pool.end();
    },
  };
}

/** Turns a stored registry row into a connectable config, decrypting secrets. */
export function toMcpServerConfig(
  row: McpServerRow,
  masterKey: Buffer,
  logger: Logger,
): McpServerConfig {
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
): Promise<void> {
  const rows = await registry.listMcpServers(true);
  await mcp.connectAll(rows.map((row) => toMcpServerConfig(row, masterKey, logger)));
}
