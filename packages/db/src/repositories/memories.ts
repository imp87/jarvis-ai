import type pg from "pg";
import { toVectorLiteral } from "../pool.js";

export type MemoryKind =
  | "note"
  | "call_transcript"
  | "email_summary"
  | "conversation"
  | "document";

export interface MemoryRow {
  id: string;
  kind: MemoryKind;
  content: string;
  sourceRef: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface MemoryHit extends MemoryRow {
  /** 1 = identical, 0 = unrelated. Derived from cosine distance. */
  similarity: number;
}

export class MemoryRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insert(input: {
    userId: string;
    kind: MemoryKind;
    content: string;
    embedding: number[];
    sourceRef?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO memories (user_id, kind, content, embedding, source_ref, metadata)
       VALUES ($1, $2, $3, $4::vector, $5::jsonb, $6::jsonb)
       RETURNING id`,
      [
        input.userId,
        input.kind,
        input.content,
        toVectorLiteral(input.embedding),
        JSON.stringify(input.sourceRef ?? {}),
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return rows[0]!.id;
  }

  /**
   * Semantic search. `minSimilarity` matters more than `limit`: returning three
   * weakly-related snippets is worse than returning none, because the model
   * treats whatever it is handed as relevant context.
   */
  async search(input: {
    userId: string;
    embedding: number[];
    limit?: number;
    minSimilarity?: number;
    kinds?: MemoryKind[];
  }): Promise<MemoryHit[]> {
    const limit = input.limit ?? 6;
    const minSimilarity = input.minSimilarity ?? 0.35;
    const { rows } = await this.pool.query<{
      id: string;
      kind: MemoryKind;
      content: string;
      source_ref: Record<string, unknown>;
      metadata: Record<string, unknown>;
      created_at: Date;
      distance: number;
    }>(
      `SELECT id, kind, content, source_ref, metadata, created_at,
              embedding <=> $2::vector AS distance
         FROM memories
        WHERE user_id = $1
          AND ($4::text[] IS NULL OR kind = ANY($4::text[]))
          AND embedding <=> $2::vector < $5
        ORDER BY distance ASC
        LIMIT $3`,
      [
        input.userId,
        toVectorLiteral(input.embedding),
        limit,
        input.kinds ?? null,
        1 - minSimilarity,
      ],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      content: r.content,
      sourceRef: r.source_ref,
      metadata: r.metadata,
      createdAt: r.created_at,
      similarity: 1 - Number(r.distance),
    }));
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM memories WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
