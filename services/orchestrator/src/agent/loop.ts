import type { ConversationRepository } from "@jarvis/db";
import { textOf, toolCallsOf, type LlmRouter } from "@jarvis/llm";
import type {
  ChannelName,
  ContentBlock,
  ExecutableTool,
  Logger,
  LlmMessage,
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
}

export interface AgentLoopOptions {
  maxSteps: number;
  timezone: string;
  historyLimit?: number;
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

    const history = await this.conversations.recentMessages(
      conversationId,
      this.options.historyLimit ?? 40,
    );
    const memoryContext = await this.memory.retrieveContext(userId, input.text);
    const system = buildSystemPrompt({
      ownerName: input.ownerName,
      channel,
      timezone: this.options.timezone,
      now: new Date(),
      memoryContext,
    });

    const available: ExecutableTool[] = await this.tools.list();
    const toolDefinitions = available.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

    const messages: LlmMessage[] = [...history];
    const toolCallNames: string[] = [];
    let steps = 0;

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
        return {
          reply:
            "I can't help with that one — the safety classifier declined the request. " +
            "If you think that's wrong, rephrase it or tell me more about what you need.",
          conversationId,
          steps,
          toolCalls: toolCallNames,
          stoppedBecause: "refusal",
        };
      }

      const calls = toolCallsOf(response.content);
      if (response.stopReason !== "tool_call" || calls.length === 0) {
        const reply = textOf(response.content);
        return {
          reply: reply || "(the model returned no text)",
          conversationId,
          steps,
          toolCalls: toolCallNames,
          stoppedBecause: response.stopReason === "max_tokens" ? "max_tokens" : "end_turn",
        };
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
    return {
      reply:
        `I worked through ${steps} steps without finishing and stopped at the step limit. ` +
        `Here's where I got to — ask me to continue if this looks right so far: ` +
        `${toolCallNames.join(", ") || "no tools ran"}.`,
      conversationId,
      steps,
      toolCalls: toolCallNames,
      stoppedBecause: "max_steps",
    };
  }
}
