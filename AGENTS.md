# Jarvis AI — repository working memory

Last reviewed: 2026-08-09.

## What this repository is

- pnpm 10 / Turborepo monorepo, TypeScript ESM, Node `>=22`.
- A self-hosted personal AI agent. The core owns LLM calls, policy decisions,
  Postgres state and credential decryption; all user-facing channels are adapters.
- Runtime configuration is environment based and validated at startup. Never
  expose, copy into code, or log values from `.env`.

## Package ownership

| Area | Responsibility |
| --- | --- |
| `packages/shared` | Canonical domain types, Zod schemas, errors, logging, crypto, call policy, daemon protocol. Update this before duplicating cross-service types. |
| `packages/db` | Postgres pool, ordered SQL migrations and repositories; pgvector memory lives here. |
| `packages/llm` | Provider adapters (Anthropic, OpenAI-compatible/Ollama), embeddings and config-driven routing. |
| `packages/mcp` | Generic MCP connection manager. |
| `packages/speech` | Shared STT/TTS abstraction: local Whisper/Piper or OpenAI. |
| `services/orchestrator` | Express API, identity gate, agent loop, memory retrieval, unified tool registry and all side-effect policy enforcement. |
| `services/telegram-adapter` | Telegram webhook or long polling, voice-note STT/TTS, then forwards to the orchestrator. |
| `services/voice-pipeline` | Asterisk/AudioSocket phone sessions; does not make policy decisions itself. |
| `apps/admin` | Next.js 15 + Mantine administrative UI. It calls the orchestrator server-side so `SERVICE_TOKEN` never reaches the browser. |

## Important flows and invariants

- Inbound channel message → `POST /v1/messages/inbound` → registered identity
  lookup → user-owned conversation → memory retrieval → agent/tool loop.
  Unknown channel identities must remain rejected before costly work (especially
  Telegram audio download/transcription).
- Tools are one flat list to the model: built-in, MCP, and database-backed HTTP
  connectors. Tool invocations are audited. Connector/MCP credentials are
  AES-256-GCM encrypted with `MASTER_KEY`, write-only in APIs and must never be
  returned or logged.
- The agent loop persists every message and caps both tool-result size and
  replayed history (`MAX_TOOL_RESULT_CHARS`, `MAX_HISTORY_CHARS`). Preserve
  provider-native `providerEcho` when extending LLM message handling.
- Call policy is a hard guardrail: quiet hours block normal calls; per-hour and
  per-day budgets block every call, including urgent ones. `0` means unlimited.
  The model must not be able to mark its own call urgent.
- Runtime call-policy overrides are read per request from the singleton
  `runtime_settings` table; `NULL` means fall back to the environment default.
  Omitted API fields mean unchanged, while explicit `null` clears an override.
- All orchestrator routes except `/health` require `Authorization: Bearer
  SERVICE_TOKEN`. Keep adapters channel-specific and the core channel-agnostic.

## Configuration and deployment

- LLM intent/profile routing belongs in
  `services/orchestrator/config/llm-routing.json`, not in call sites or `.env`.
- `EMBEDDING_DIM` is part of the database schema. Changing embedding models or
  dimensions requires a new migration and re-embedding; do not change it
  casually once memories exist.
- Docker binds local ports by default: Postgres `15432`, orchestrator `18780`,
  Telegram adapter `18781`, voice HTTP `18782`, admin `18783`, AudioSocket
  `18790`. The Next.js development server uses port `3800`.
- Telegram long polling is the supported home-network mode; only one instance
  may poll a bot. The voice pipeline is designed for LAN Asterisk/FritzBox use.

## Working conventions

- Add database changes as a new, numbered migration in `packages/db/migrations`;
  never rewrite applied migrations. Use `pnpm db:migrate` locally or the Docker
  migration runner in deployment.
- Keep Zod validation at ingress points and repository SQL parameterized.
- Preserve the user’s existing dirty worktree. At this review it contains
  uncommitted runtime-policy work spanning migration `005_runtime_settings.sql`,
  DB settings/identity repositories, orchestrator policy/call/status/admin code,
  and related admin UI/API files, plus `.claude/`; inspect `git status` before
  editing those areas.
- `README.md` and `docs/roadmap.md` contain useful design rationale but can lag
  behind implementation. Confirm current behavior in source and tests first;
  Telegram, the admin UI, and the voice pipeline now have substantial code.

## Useful commands

```powershell
pnpm typecheck                  # all 9 workspaces; verified passing on 2026-08-09
pnpm test                       # unit tests via Turbo
pnpm build                      # full production build
pnpm db:migrate                 # apply ordered migrations
pnpm orchestrator:dev           # run core with hot reload
pnpm telegram:dev               # run Telegram adapter with hot reload
pnpm admin:dev                  # run admin UI at http://localhost:3800
pnpm --filter @jarvis/voice-pipeline run dev
```

Run long-lived services in separate terminals rather than `turbo run dev`, so
startup failures stay visible. Before behavior changes, prefer the focused
workspace test plus `pnpm typecheck`; add regression tests next to the affected
workspace where practical.
