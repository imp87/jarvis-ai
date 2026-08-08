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

# 4. Build and run
pnpm build
pnpm orchestrator:dev
```

Check it: `curl localhost:8080/health`, then
`curl -H "authorization: Bearer $SERVICE_TOKEN" localhost:8080/v1/status`.

### First user

Nothing can talk to the agent until an identity is registered — an unknown
Telegram user who finds the bot gets a 403, by design.

```bash
TOKEN=...   # SERVICE_TOKEN from .env
USER_ID=$(curl -s -X POST localhost:8080/v1/users \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"displayName":"Steve","isOwner":true}' | jq -r .id)

curl -X POST localhost:8080/v1/identities \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"channel\":\"telegram\",\"channelUserId\":\"<your telegram id>\"}"

# Talk to the agent without any channel adapter:
curl -X POST localhost:8080/v1/actions/agent \
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
apps/          (Next.js admin UI — next phase)
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
| `pnpm db:migrate` | Apply migrations (idempotent, checksummed) |
| `pnpm orchestrator:dev` | Run the orchestrator with hot reload |

## Configuration

All configuration is environment variables, validated at startup — a missing
secret crashes the process immediately rather than surfacing as a 500 later.
See [.env.example](.env.example) for the full list.

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
