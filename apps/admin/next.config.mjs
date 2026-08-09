import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

// `new URL('../../', import.meta.url).pathname` would produce "/D:/..." on
// Windows — a path that exists nowhere, which Next accepts silently and which
// then costs you the standalone output with no error to go on.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Next only reads .env files next to the app, but every other service in this
// repo is configured from the one at the root. Loading it here keeps a single
// file to edit. In Docker the environment is injected directly, and standalone
// builds never evaluate this config at runtime — so this is a dev-only path.
loadDotenv({ path: join(repoRoot, ".env") });

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emits a self-contained server bundle in .next/standalone, so the runtime
  // image needs neither node_modules nor pnpm — the same shape as the other
  // services' Dockerfiles.
  output: "standalone",
  // The build context is the repo root: workspace packages live above this
  // directory, and without this Next traces file dependencies from the wrong
  // root and ships an incomplete bundle.
  outputFileTracingRoot: repoRoot,
  poweredByHeader: false,
  reactStrictMode: true,
};

/**
 * Dev and build must not share a build directory.
 *
 * `pnpm build` runs `next build` through Turborepo, which happily writes into
 * the `.next` a running `pnpm admin:dev` is serving from. The dev server then
 * fails with `__webpack_modules__[moduleId] is not a function` — a message that
 * points nowhere near the actual cause. Separate directories make the two
 * commands independent, which is how everything else in this repo already behaves.
 */
export default function config(phase) {
  return phase === PHASE_DEVELOPMENT_SERVER
    ? { ...nextConfig, distDir: ".next-dev" }
    : nextConfig;
}
