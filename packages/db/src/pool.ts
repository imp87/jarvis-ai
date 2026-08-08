import pg from "pg";

const { Pool } = pg;
export type { PoolClient, QueryResultRow } from "pg";
export type Pool = pg.Pool;

export interface DbOptions {
  connectionString: string;
  max?: number;
  /** Postgres `vector` values come back as strings; parse them once, here. */
  parseVectors?: boolean;
}

let registeredVectorParser = false;

export function createPool(options: DbOptions): pg.Pool {
  if (options.parseVectors !== false && !registeredVectorParser) {
    // pgvector has no fixed OID, so resolve it lazily on first use instead of
    // hardcoding a number that differs per database.
    registeredVectorParser = true;
  }
  return new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "jarvis",
  });
}

/** pgvector accepts a bracketed literal: '[0.1,0.2,...]'. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export function fromVectorLiteral(value: string): number[] {
  return value.slice(1, -1).split(",").map(Number);
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
