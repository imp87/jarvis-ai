import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Logger } from "@jarvis/shared";
import { renderToolContent } from "./tool-content.js";

/**
 * The one vendor-specific exception in an otherwise generic MCP layer.
 *
 * Stripe's hosted MCP server requires a `stripe_context` value that is returned
 * by a separate account-selection tool. It is an opaque value, not the
 * human-readable account name, so asking the model to copy it reliably is
 * needlessly brittle. For a single authorised account it is loaded once and
 * attached to every Stripe tool that declares the parameter.
 *
 * This is deliberately quarantined in its own file rather than sitting in
 * `manager.ts`: the manager's contract is "any MCP server becomes tools, with
 * no per-service code". If a second server ever needs the same treatment, the
 * right move is a general argument-interceptor hook on `McpManager` — not a
 * second special case wired into the connect path.
 */
export class StripeContextResolver {
  private context: string | undefined;
  private attempted = false;

  constructor(
    private readonly client: Client,
    private readonly tools: Array<{ name: string; inputSchema?: unknown }>,
    private readonly logger: Logger,
  ) {}

  /** Applies to this server only when the tool actually declares the parameter. */
  static isStripe(serverName: string): boolean {
    return serverName.toLowerCase() === "stripe";
  }

  async apply(
    toolName: string,
    inputSchema: unknown,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (toolName === "list_available_accounts_or_orgs" || !declaresStripeContext(inputSchema)) {
      return args;
    }
    if (!this.context) await this.load();
    // Intentionally overwrite an LLM-supplied display name or stale context:
    // this value came from the active OAuth session moments ago.
    return { ...args, stripe_context: this.context };
  }

  /**
   * Chooses the context, but only when exactly one account/org is authorised —
   * with several, picking the first could query the wrong business.
   */
  private async load(): Promise<void> {
    if (this.attempted) {
      throw new Error("Stripe account context is unavailable. Reconnect Stripe and try again.");
    }
    this.attempted = true;
    const selector = this.tools.find((tool) => tool.name === "list_available_accounts_or_orgs");
    if (!selector) {
      throw new Error("Stripe MCP did not provide an account-context selector.");
    }
    const result = await this.client.callTool({ name: selector.name, arguments: {} });
    const contexts = extractStripeContexts(renderToolContent(result.content));
    if (contexts.length !== 1) {
      throw new Error(
        contexts.length === 0
          ? "Stripe did not return an account context for this OAuth session."
          : "Several Stripe accounts are authorised; select one explicitly before querying data.",
      );
    }
    this.context = contexts[0];
    this.logger.info(
      { contextCount: contexts.length },
      "Stripe account context selected for MCP connection",
    );
  }
}

function declaresStripeContext(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const properties = (schema as { properties?: unknown }).properties;
  return Boolean(properties && typeof properties === "object" && "stripe_context" in properties);
}

function extractStripeContexts(content: string): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key === "stripe_context" && typeof item === "string" && item.trim()) found.add(item);
        else visit(item);
      }
    }
  };
  try {
    visit(JSON.parse(content));
  } catch {
    // Some MCP servers render a human-readable table rather than JSON.
    for (const match of content.matchAll(
      /["']?stripe_context["']?\s*[:=]\s*["']?([^\s,"'}\]]+)/gi,
    )) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}
