# Jarvis — selfhosted personal AI agent

A personal agent you own end to end: chat channels, long-term memory, a tool
registry, MCP integration and (later) real phone calls. Cloud LLM APIs are used
as a *provider*, never as the platform — orchestration, data and logic stay here.

**Status:** Phase 1 complete. The Core Agent Orchestrator runs: LLM provider
abstraction, Postgres + pgvector, MCP client layer, tool registry, agent loop,
REST API. Everything else is scaffolded or specified, not built. See
[docs/roadmap.md](docs/roadmap.md).

---

## Quick start

```bash
# 1. Toolchain (pnpm is required; corepack needs admin on Windows, npm doesn't)
npm install -g pnpm
pnpm install

# 2. Secrets
cp .env.example .env
node -e "console.log('MASTER_KEY='+require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('SERVICE_TOKEN='+require('crypto').randomBytes(32).toString('hex'))"
# paste both into .env, add ANTHROPIC_API_KEY and OPENAI_API_KEY

# 3. Database
docker compose up -d postgres
pnpm db:migrate
# On a server with only Docker installed, use this instead — same migrations,
# run from the orchestrator image, no Node or pnpm required:
#   docker compose run --rm migrate

# 4. Build and run
pnpm build
pnpm orchestrator:dev
```

Check it: `curl localhost:18780/health`, then
`curl -H "authorization: Bearer $SERVICE_TOKEN" localhost:18780/v1/status`.

### Admin UI

Set `ADMIN_PASSWORD` in `.env` (at least 12 characters), then:

```bash
pnpm admin:dev        # http://localhost:3800
```

Attaching an MCP server, adding an HTTP connector and its endpoints, editing
quiet hours and the call budget, managing users and their per-channel reply
settings, and seeing which tools the agent currently has all happen here
instead of by curl. The
orchestrator's `SERVICE_TOKEN` stays server-side — every call goes through the
Next.js server, so a browser session can never be turned into direct API access.
When a server fails to connect, the reason is shown on the server's row rather
than only in the orchestrator log.

### First user

Nothing can talk to the agent until an identity is registered — an unknown
Telegram user who finds the bot gets a 403, by design.

```bash
TOKEN=...   # SERVICE_TOKEN from .env
USER_ID=$(curl -s -X POST localhost:18780/v1/users \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"displayName":"Steve","isOwner":true}' | jq -r .id)

curl -X POST localhost:18780/v1/identities \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"channel\":\"telegram\",\"channelUserId\":\"<your telegram id>\"}"

# Talk to the agent without any channel adapter:
curl -X POST localhost:18780/v1/actions/agent \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"text\":\"What can you do?\"}"
```

---

## Layout

```
packages/
  shared/    domain types, errors, logging, crypto, policy, daemon protocol
  db/        Postgres pool, migrations, repositories (pgvector lives here)
  llm/       provider abstraction: Anthropic, OpenAI-compatible, Ollama + routing
  mcp/       generic MCP client layer — any MCP server becomes agent tools
services/
  orchestrator/  Express API, agent loop, tool registry  ← the core
  telegram-adapter/  Bot API long polling, voice notes in and out
  voice-pipeline/    SIP calls via Asterisk + AudioSocket
apps/
  admin/     Next.js admin UI — MCP servers and connectors without curl
docs/          architecture, roadmap, PC-daemon protocol
```

One monorepo, pnpm workspaces + Turborepo. Every component still builds and
ships as its own container; the shared vocabulary (`@jarvis/shared`) is what
keeps a Telegram message, a phone call and an email classification the same
kind of object. See [docs/architecture.md](docs/architecture.md#why-a-monorepo).

## Commands

| Command | What it does |
|---|---|
| `pnpm build` | Build every package (Turborepo, cached) |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm test` | Run unit tests |
| `pnpm db:migrate` | Apply migrations (idempotent, checksummed) — needs the dev toolchain |
| `docker compose run --rm migrate` | The same migrations, from the image — needs nothing but Docker |
| `pnpm orchestrator:dev` | Run the orchestrator with hot reload |
| `pnpm telegram:dev` | Run the Telegram adapter with hot reload |
| `pnpm admin:dev` | Run the admin UI with hot reload (port 3800) |

**Run the services in separate terminals, not via `turbo run dev`.** Turbo
multiplexes persistent tasks into one output stream (or a TUI pane per task),
so when one service fails to start you get silence rather than its error — and
on Windows the orchestrator did not come up under Turbo at all in testing.
Turbo is worth having for `build`, where the caching pays off; for running two
long-lived processes it only hides information you need.

### Running in Docker (the deployment target)

```bash
docker compose build
docker compose up -d postgres orchestrator admin
```

Migrations from the image, so a server needs no Node or pnpm installed:

```bash
docker compose run --rm --no-deps orchestrator node --input-type=module -e "
import { createPool, runMigrations } from '@jarvis/db';
const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 2 });
const { applied } = await runMigrations(pool, {
  variables: { EMBEDDING_DIM: Number(process.env.EMBEDDING_DIM ?? 1536) },
  log: (m) => console.log('[migrate]', m),
});
console.log(applied.length ? 'applied: ' + applied.join(', ') : 'already up to date');
await pool.end();
"
```

The `telegram-adapter` image expects a **Linux** Piper build mounted at
`/opt/piper` (`PIPER_HOST_DIR`). The `.local/piper` in this repo is whatever
your dev machine downloaded — on Windows that is a `.exe` and will not run in
the container. Either mount Linux binaries or set `TTS_ENGINE=openai`.

## Configuration

Configuration is environment variables, validated at startup — a missing secret
crashes the process immediately rather than surfacing as a 500 later. See
[.env.example](.env.example) for the full list.

**Two exceptions, edited in the admin UI and stored in the database:** quiet
hours and the call budget. They are decisions about your evening rather than
deployment settings, they change more often than the code does, and requiring a
container restart to move quiet hours by an hour is the kind of friction that
ends with the guard rail switched off entirely. The environment still supplies
the defaults; a setting you have not touched comes from there, and clearing an
override hands it back rather than leaving a second, forgotten copy.

LLM routing is **not** environment configuration: it lives in
[`services/orchestrator/config/llm-routing.json`](services/orchestrator/config/llm-routing.json)
so you can move work between Claude, GPT and a local Ollama model without
touching code.

## Security

- Nothing is reachable unauthenticated except `/health`.
- Connector credentials are AES-256-GCM encrypted with `MASTER_KEY` before they
  touch the database, decrypted only at call time, and never returned by any API.
- Only registered channel identities can interact with the agent.
- Anything that costs money or rings a phone has a hard ceiling: LLM calls per
  minute, agent steps per turn, calls per hour and per day, plus quiet hours.
- Postgres and the orchestrator bind to loopback in `docker-compose.yml`; TLS
  and public exposure are Nginx Proxy Manager's job.

Full reasoning: [docs/architecture.md](docs/architecture.md).
