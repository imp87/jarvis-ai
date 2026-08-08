import type { EmbeddingProvider } from "@jarvis/llm";
import type { MemoryHit, MemoryKind, MemoryRepository } from "@jarvis/db";
import type { Logger } from "@jarvis/shared";

/**
 * RAG layer. Retrieval runs before every agent turn: relevant snippets are
 * pulled by embedding similarity and injected into the system prompt.
 */
export class MemoryService {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly embeddings: EmbeddingProvider,
    private readonly logger: Logger,
  ) {}

  async remember(input: {
    userId: string;
    kind: MemoryKind;
    content: string;
    sourceRef?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const [embedding] = await this.embeddings.embed([input.content]);
    if (!embedding) throw new Error("embedding provider returned no vector");
    return this.repo.insert({ ...input, embedding });
  }

  async search(input: {
    userId: string;
    query: string;
    limit?: number;
    minSimilarity?: number;
    kinds?: MemoryKind[];
  }): Promise<MemoryHit[]> {
    const [embedding] = await this.embeddings.embed([input.query]);
    if (!embedding) return [];
    return this.repo.search({
      userId: input.userId,
      embedding,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.minSimilarity !== undefined ? { minSimilarity: input.minSimilarity } : {}),
      ...(input.kinds ? { kinds: input.kinds } : {}),
    });
  }

  /**
   * Retrieval for the agent loop. Failures here are non-fatal: answering
   * without remembered context beats not answering at all, so a dead embedding
   * endpoint degrades quality rather than taking the agent down.
   */
  async retrieveContext(userId: string, query: string): Promise<string | null> {
    try {
      const hits = await this.search({ userId, query, limit: 6, minSimilarity: 0.4 });
      if (hits.length === 0) return null;
      return hits
        .map(
          (hit) =>
            `- [${hit.kind}, ${hit.createdAt.toISOString().slice(0, 10)}, ` +
            `similarity ${hit.similarity.toFixed(2)}] ${hit.content}`,
        )
        .join("\n");
    } catch (err) {
      this.logger.warn({ err: String(err) }, "memory retrieval failed; continuing without context");
      return null;
    }
  }
}
