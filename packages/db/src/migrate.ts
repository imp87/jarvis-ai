import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Works from both `src/` (tsx) and `dist/` (built). */
export const MIGRATIONS_DIR = path.resolve(here, "..", "migrations");

export interface MigrateOptions {
  /** Values substituted into `${NAME}` placeholders in the SQL. */
  variables?: Record<string, string | number>;
  log?: (message: string) => void;
}

function substitute(sql: string, variables: Record<string, string | number>): string {
  return sql.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      throw new Error(`migration references \${${name}} but no value was provided`);
    }
    // Placeholders only ever hold numbers or identifiers we control, but be
    // explicit rather than trusting the caller.
    if (!/^[\w.]+$/.test(String(value))) {
      throw new Error(`refusing to substitute unsafe value for \${${name}}`);
    }
    return String(value);
  });
}

export async function runMigrations(
  pool: pg.Pool,
  options: MigrateOptions = {},
): Promise<{ applied: string[] }> {
  const log = options.log ?? (() => undefined);
  const variables = options.variables ?? {};

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const { rows } = await pool.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM schema_migrations",
  );
  const already = new Map(rows.map((r) => [r.name, r.checksum]));
  const applied: string[] = [];

  for (const file of files) {
    const raw = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const sql = substitute(raw, variables);
    const checksum = createHash("sha256").update(sql).digest("hex");

    const previous = already.get(file);
    if (previous) {
      if (previous !== checksum) {
        // A silently edited applied migration means dev and prod schemas have
        // diverged. Fail loudly rather than re-running it.
        throw new Error(
          `migration ${file} was modified after it was applied ` +
            `(checksum ${previous.slice(0, 12)} -> ${checksum.slice(0, 12)}). ` +
            `Write a new migration instead of editing this one.`,
        );
      }
      continue;
    }

    log(`applying ${file}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
        [file, checksum],
      );
      await client.query("COMMIT");
      applied.push(file);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }

  return { applied };
}
