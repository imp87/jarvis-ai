import type { ConversationRepository } from "@jarvis/db";
import { textOf, toolCallsOf, type LlmRouter } from "@jarvis/llm";
import type {
  ChannelName,
  ContentBlock,
  ExecutableTool,
  Logger,
  LlmMessage,
  TurnSignals,
} from "@jarvis/shared";
import { buildSystemPrompt } from "./prompt.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { MemoryService } from "../services/memory.js";

export interface AgentRunInput {
  userId: string;
  ownerName: string;
  conversationId: string;
  channel: ChannelName;
  text: string;
  /** Routing profile; falls back to the router's default. */
  profile?: string | undefined;
}

export interface AgentRunResult {
  reply: string;
  conversationId: string;
  steps: number;
  toolCalls: string[];
  stoppedBecause: "end_turn" | "max_steps" | "refusal" | "max_tokens" | "other";
  /**
   * Set when the agent asked to hang up. The caller is expected to deliver
   * `reply` first — this is a request to end the call after it, not instead of it.
   */
  endCall?: { reason: string };
}

export interface AgentLoopOptions {
  maxSteps: number;
  timezone: string;
  historyLimit?: number;
  /** See MAX_HISTORY_CHARS. A message count bounds nothing on its own. */
  maxHistoryChars?: number;
}

/**
 * Drops the oldest messages until the replayed history fits the budget.
 *
 * The subtlety is that a `tool_result` is only valid immediately after the
 * `tool_call` that produced it — every provider rejects an orphan. So after
 * trimming by size, any leading tool results whose call was just dropped go
 * too, even if that costs more than the budget required.
 */
export function trimHistory(messages: LlmMessage[], maxChars: number): LlmMessage[] {
  let used = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const size = JSON.stringify(messages[i]?.content ?? "").length;
    // Always keep the newest message, however large: dropping the turn the user
    // just took would be worse than exceeding the budget once.
    if (used + size > maxChars && i < messages.length - 1) break;
    used += size;
    start = i;
  }

  const kept = messages.slice(start);
  while (kept.length > 0 && startsWithOrphanedToolResult(kept[0])) kept.shift();
  return kept;
}

function startsWithOrphanedToolResult(message: LlmMessage | undefined): boolean {
  if (!message || typeof message.content === "string") return false;
  return message.content.some((block) => block.type === "tool_result");
}

/**
 * The agentic loop: call the model, run whatever tools it asks for, feed the
 * results back, repeat until it stops asking. Every turn is persisted as it
 * happens so a crash mid-loop leaves a truthful transcript rather than a hole.
 */
export class AgentLoop {
  constructor(
    private readonly router: LlmRouter,
    private readonly tools: ToolRegistry,
    private readonly memory: MemoryService,
    private readonly conversations: ConversationRepository,
    private readonly logger: Logger,
    private readonly options: AgentLoopOptions,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const { userId, conversationId, channel } = input;

    await this.conversations.appendMessage({
      conversationId,
      role: "user",
      content: [{ type: "text", text: input.text }],
      channel,
    });

    const loaded = await this.conversations.recentMessages(
      conversationId,
      this.options.historyLimit ?? 40,
    );
    const history = trimHistory(loaded, this.options.maxHistoryChars ?? 48_000);
    if (history.length < loaded.length) {
      this.logger.info(
        { conversationId, dropped: loaded.length - history.length, kept: history.length },
        "history trimmed to fit the context budget",
      );
    }
    const memoryContext = await this.memory.retrieveContext(userId, input.text);
    const system = buildSystemPrompt({
      ownerName: input.ownerName,
      channel,
      timezone: this.options.timezone,
      now: new Date(),
      memoryContext,
    });

    // Tools a channel cannot support are never offered — see `ExecutableTool.channels`.
    const available: ExecutableTool[] = await this.tools.list(channel);
    const toolDefinitions = available.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

    const messages: LlmMessage[] = [...history];
    const toolCallNames: string[] = [];
    // Shared with every tool this turn; `end_call` writes into it.
    const signals: TurnSignals = {};
    let steps = 0;

    const finish = (
      result: Omit<AgentRunResult, "endCall">,
    ): AgentRunResult => ({
      ...result,
      ...(signals.endCall ? { endCall: signals.endCall } : {}),
    });

    while (steps < this.options.maxSteps) {
      steps += 1;

      const response = await this.router.chat(input.profile, {
        system,
        messages,
        tools: toolDefinitions,
      });

      const assistantMessage: LlmMessage = {
        role: "assistant",
        content: response.content,
        ...(response.providerEcho ? { providerEcho: response.providerEcho } : {}),
      };
      messages.push(assistantMessage);

      await this.conversations.appendMessage({
        conversationId,
        role: "assistant",
        content: response.content,
        ...(response.providerEcho ? { providerEcho: response.providerEcho } : {}),
        channel,
        provider: response.provider,
        model: response.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });

      if (response.stopReason === "refusal") {
        this.logger.warn(
          { conversationId, category: response.refusal?.category },
          "model declined the request",
        );
        return finish({
          reply:
            "I can't help with that one — the safety classifier declined the request. " +
            "If you think that's wrong, rephrase it or tell me more about what you need.",
          conversationId,
          steps,
          toolCalls: toolCallNames,
          stoppedBecause: "refusal",
        });
      }

      const calls = toolCallsOf(response.content);
      if (response.stopReason !== "tool_call" || calls.length === 0) {
        const reply = textOf(response.content);
        return finish({
          reply: reply || "(the model returned no text)",
          conversationId,
          steps,
          toolCalls: toolCallNames,
          stoppedBecause: response.stopReason === "max_tokens" ? "max_tokens" : "end_turn",
        });
      }

      // Parallel tool calls arrive together and must all come back in a single
      // follow-up message — splitting them teaches the model to stop batching.
      const results = await Promise.all(
        calls.map(async (call) => {
          toolCallNames.push(call.name);
          const result = await this.tools.execute(available, call.name, call.arguments, {
            conversationId,
            userId,
            channel,
            signals,
          });
          return { call, result };
        }),
      );

      const resultBlocks: ContentBlock[] = results.map(({ call, result }) => ({
        type: "tool_result",
        toolCallId: call.id,
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
      }));

      const resultMessage: LlmMessage = { role: "user", content: resultBlocks };
      messages.push(resultMessage);
      await this.conversations.appendMessage({
        conversationId,
        role: "user",
        content: resultBlocks,
        channel,
      });
    }

    this.logger.warn(
      { conversationId, steps, toolCalls: toolCallNames },
      "agent hit the step ceiling",
    );
    return finish({
      reply:
        `I worked through ${steps} steps without finishing and stopped at the step limit. ` +
        `Here's where I got to — ask me to continue if this looks right so far: ` +
        `${toolCallNames.join(", ") || "no tools ran"}.`,
      conversationId,
      steps,
      toolCalls: toolCallNames,
      stoppedBecause: "max_steps",
    });
  }
}
