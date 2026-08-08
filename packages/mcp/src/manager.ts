import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExecutableTool, Logger, ToolResult } from "@jarvis/shared";

/**
 * Generic MCP client layer (component 3). Any MCP server — Gmail, Calendar,
 * Slack, something you wrote this afternoon — becomes a set of tools the agent
 * can call, with no per-service code here. Servers are configured as data
 * (`mcp_servers` table) and loaded at startup.
 */

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  /** transport === "http" */
  url?: string | null;
  /** transport === "stdio" */
  command?: string | null;
  args?: string[];
  /** Decrypted at the call site: HTTP headers, or env vars for a stdio server. */
  secrets?: Record<string, string>;
}

interface Connection {
  config: McpServerConfig;
  client: Client;
  tools: ExecutableTool[];
}

/** Tool names must be unique and stable across the whole agent. */
function toolName(server: string, tool: string): string {
  return `mcp_${sanitize(server)}__${sanitize(tool)}`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
}

export class McpManager {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly logger: Logger) {}

  /**
   * Connects every configured server. One unreachable server must not stop the
   * agent from starting — its tools are simply absent and the failure is
   * logged, because a dead Slack server is not a reason to stop answering
   * messages on Telegram.
   */
  async connectAll(configs: McpServerConfig[]): Promise<void> {
    const results = await Promise.allSettled(configs.map((c) => this.connect(c)));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.logger.error(
          { server: configs[index]?.name, err: String(result.reason) },
          "MCP server connection failed; its tools are unavailable",
        );
      }
    });
  }

  async connect(config: McpServerConfig): Promise<void> {
    await this.disconnect(config.name);

    const client = new Client(
      { name: "jarvis-orchestrator", version: "0.1.0" },
      { capabilities: {} },
    );

    if (config.transport === "http") {
      if (!config.url) throw new Error(`MCP server "${config.name}" has no url`);
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.secrets ?? {} },
      });
      await client.connect(transport);
    } else {
      if (!config.command) throw new Error(`MCP server "${config.name}" has no command`);
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        // Only the secrets this server needs — not the orchestrator's whole
        // environment, which holds every other provider's API key.
        env: { ...config.secrets },
      });
      await client.connect(transport);
    }

    const listed = await client.listTools();
    const tools: ExecutableTool[] = listed.tools.map((tool) => ({
      name: toolName(config.name, tool.name),
      description:
        tool.description ?? `${tool.name} (from MCP server "${config.name}", no description)`,
      inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<
        string,
        unknown
      >,
      source: "mcp",
      // An MCP server can do anything; assume side effects unless the server
      // annotates otherwise via the readOnlyHint annotation.
      sideEffects: tool.annotations?.readOnlyHint !== true,
      execute: async (args): Promise<ToolResult> => {
        const result = await client.callTool({ name: tool.name, arguments: args });
        return {
          content: renderToolContent(result.content),
          ...(result.isError ? { isError: true } : {}),
        };
      },
    }));

    this.connections.set(config.name, { config, client, tools });
    this.logger.info(
      { server: config.name, transport: config.transport, toolCount: tools.length },
      "MCP server connected",
    );
  }

  async disconnect(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;
    this.connections.delete(name);
    await connection.client.close().catch((err: unknown) => {
      this.logger.warn({ server: name, err: String(err) }, "MCP disconnect failed");
    });
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((name) => this.disconnect(name)));
  }

  listTools(): ExecutableTool[] {
    return [...this.connections.values()].flatMap((c) => c.tools);
  }

  listServers(): Array<{ name: string; transport: string; toolCount: number }> {
    return [...this.connections.values()].map((c) => ({
      name: c.config.name,
      transport: c.config.transport,
      toolCount: c.tools.length,
    }));
  }
}

/** MCP returns structured content; the agent loop needs a single string. */
function renderToolContent(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? null);
  const parts: string[] = [];
  for (const item of content as Array<Record<string, unknown>>) {
    if (item["type"] === "text" && typeof item["text"] === "string") {
      parts.push(item["text"]);
    } else if (item["type"] === "resource") {
      parts.push(JSON.stringify(item["resource"]));
    } else {
      // Images and audio can't go into a text tool result; describe them so the
      // model knows something came back rather than seeing an empty string.
      parts.push(`[${String(item["type"] ?? "unknown")} content omitted]`);
    }
  }
  return parts.join("\n");
}
