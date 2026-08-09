import type { RegistryRepository } from "@jarvis/db";
import type { McpManager } from "@jarvis/mcp";
import type {
  ChannelName,
  ExecutableTool,
  Logger,
  ToolContext,
  ToolResult,
} from "@jarvis/shared";
import { buildConnectorTool } from "./connectors.js";

/**
 * Single place the agent asks "what can I do right now". Built-in tools are
 * fixed; MCP tools come from live connections; connector tools are rebuilt from
 * the database so a tool registered in the UI is usable on the next turn
 * without a restart.
 */
export class ToolRegistry {
  constructor(
    private readonly builtins: ExecutableTool[],
    private readonly mcp: McpManager,
    private readonly registryRepo: RegistryRepository,
    private readonly masterKey: Buffer,
    private readonly logger: Logger,
  ) {}

  /**
   * @param channel Restricts the result to tools usable on this channel. Omit —
   * as the status endpoint does — to see everything that is registered.
   */
  async list(channel?: ChannelName): Promise<ExecutableTool[]> {
    const connectorTools: ExecutableTool[] = [];
    try {
      const rows = await this.registryRepo.listCallableEndpoints();
      for (const { connector, endpoint } of rows) {
        connectorTools.push(
          buildConnectorTool(connector, endpoint, this.masterKey, this.logger),
        );
      }
    } catch (err) {
      this.logger.error({ err: String(err) }, "failed to load connector tools");
    }

    const all = [...this.builtins, ...this.mcp.listTools(), ...connectorTools].filter(
      (tool) => !channel || !tool.channels || tool.channels.includes(channel),
    );

    // A duplicate tool name makes the model's choice ambiguous and the provider
    // may reject the request outright. Drop the later one and say so loudly.
    const seen = new Map<string, ExecutableTool>();
    for (const tool of all) {
      if (seen.has(tool.name)) {
        this.logger.warn({ tool: tool.name }, "duplicate tool name; keeping the first");
        continue;
      }
      seen.set(tool.name, tool);
    }
    return [...seen.values()];
  }

  /** Executes a tool and writes the audit row. Never throws — errors go back to the model. */
  async execute(
    tools: ExecutableTool[],
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: `Unknown tool "${name}". Available: ${tools.map((t) => t.name).join(", ")}`,
        isError: true,
      };
    }

    const started = Date.now();
    let result: ToolResult;
    try {
      result = await tool.execute(args, ctx);
    } catch (err) {
      // A throwing tool must not kill the turn: hand the model the error so it
      // can adapt, exactly as the API expects for is_error results.
      result = { content: `Tool "${name}" failed: ${(err as Error).message}`, isError: true };
    }
    const durationMs = Date.now() - started;

    await this.registryRepo
      .logToolInvocation({
        conversationId: ctx.conversationId,
        toolName: name,
        source: tool.source,
        arguments: args,
        ok: !result.isError,
        ...(result.isError ? { error: result.content.slice(0, 1000) } : {}),
        durationMs,
      })
      .catch((err: unknown) => {
        this.logger.error({ err: String(err) }, "failed to write tool audit row");
      });

    this.logger.info(
      { tool: name, source: tool.source, ok: !result.isError, durationMs },
      "tool executed",
    );
    return result;
  }
}
