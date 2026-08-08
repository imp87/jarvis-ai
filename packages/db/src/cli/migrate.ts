#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../pool.js";
import { runMigrations } from "../migrate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../../.env") });

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  console.error("DATABASE_URL is not set (looked in the repo-root .env too)");
  process.exit(1);
}

const embeddingDim = Number(process.env["EMBEDDING_DIM"] ?? 1536);
if (!Number.isInteger(embeddingDim) || embeddingDim <= 0) {
  console.error(`EMBEDDING_DIM must be a positive integer, got ${process.env["EMBEDDING_DIM"]}`);
  process.exit(1);
}

const pool = createPool({ connectionString, max: 2 });

try {
  const { applied } = await runMigrations(pool, {
    variables: { EMBEDDING_DIM: embeddingDim },
    log: (message) => console.log(`[migrate] ${message}`),
  });
  console.log(
    applied.length > 0
      ? `[migrate] applied ${applied.length} migration(s): ${applied.join(", ")}`
      : "[migrate] database already up to date",
  );
} catch (err) {
  console.error(`[migrate] ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
