# Architecture

## Why a monorepo

Every component in this system speaks the same three vocabularies: the message
format, the tool format, and the database schema. A Telegram message, a phone
call transcript and an email classification all become the same
`LlmMessage`/`ContentBlock` objects, and every component that persists anything
shares one schema.

With separate repos, changing `ContentBlock` means publishing a package version
and bumping it in four places — several times a day during prototyping. One
repo, `pnpm` workspaces, `@jarvis/shared` as the single source of truth.

What this deliberately does **not** cost you: components are still independent
services with their own APIs and their own containers. Turborepo builds each one
in isolation, and the orchestrator's Dockerfile only pulls the workspace closure
it actually needs. When the PC daemon eventually runs on your desktop and the
wake-word client on a Pi, they move out cleanly — they depend on
`@jarvis/shared` and nothing else.

## The shape of the system

```
   channel adapters                    Core Agent Orchestrator
 ┌──────────────────┐                ┌──────────────────────────┐
 │ Telegram         │                │  agent loop              │
 │ Discord          │──POST /v1/─────▶  ├─ retrieval (pgvector)  │
 │ Voice call       │  messages/     │  ├─ LLM routing          │──▶ Anthropic
 │ Wake word        │  inbound       │  ├─ tool calling         │──▶ OpenAI
 └──────────────────┘                │  └─ audit                │──▶ Ollama (LAN)
                                     └───────────┬──────────────┘
 ┌──────────────────┐                            │
 │ E-mail monitor   │──POST /v1/actions/call─────┤
 └──────────────────┘                            │
                            ┌────────────────────┼───────────────────┐
                            ▼                    ▼                   ▼
                     built-in tools        MCP servers        HTTP connectors
                     (memory, call)     (Gmail, Calendar…)   (Stripe, Supabase…)
                            │                    │                   │
                            └────────────────────┴───────────────────┘
                                                 │
                                      Postgres + pgvector
```

The orchestrator is the only component that talks to the LLM, the only one that
holds the master key, and the only one that decides whether an action is allowed.

## Design decisions

### Channels are adapters, the core is channel-agnostic

The orchestrator has exactly one ingress: `POST /v1/messages/inbound` with
`{channel, channelUserId, text}`. It knows nothing about bot tokens, chat ids or
Opus files. An adapter's whole job is: receive, transcribe if needed, forward,
render the reply.

Two consequences worth naming:

- **Adding Slack or WhatsApp is a new adapter, not a change to the core.**
- **Conversations are not per-channel.** A `conversation` belongs to a user, not
  to Telegram. A question asked in chat and continued on a phone call is one
  thread, because the channel is recorded per *message*. That is what makes
  "Frage auf Telegram, Fortsetzung per Anruf" work at all.

### One LLM interface, three providers, routing in config

The internal interface is modelled on the OpenAI chat-completions shape because
that is the de-facto standard every local runtime implements. Adapters translate
in and out; provider-specific shapes never leak past their adapter.

`config/llm-routing.json` maps *intents* (`chat`, `agent`, `classify`) to
providers and models. Call sites ask for an intent, never for a model. Moving
classification to the Mini-PC is a config edit.

Three details that matter more than they look:

- **Tool-calling capability is a hard routing criterion.** A profile whose
  provider can't call tools declares a `fallbackProfile`; a request carrying
  tools is rerouted rather than silently answered in prose. Not every model
  Ollama can run does function calling reliably — prefer Llama 3.1+ / Qwen 2.5+
  and verify with a real round trip.
- **A profile naming an unconfigured provider is a startup error.** Silently
  falling back is how you pay Anthropic rates for work you thought was local.
- **`providerEcho`.** Reasoning blocks are signed; reconstructing them from our
  unified representation gets the next request rejected. So each assistant
  message keeps the provider-native content verbatim alongside the normalised
  version, and replays it when the same provider serves the next turn.

Sampling parameters are accepted by the interface and dropped by the Anthropic
adapter for models that reject them, so no call site has to track which model is
which.

### Memory is Postgres, not a second database

pgvector runs inside the same Postgres that holds conversations and audit rows.
No second system to run, back up, or keep consistent.

Retrieval runs before every agent turn and injects matching snippets into the
system prompt. `minSimilarity` matters more than `limit`: handing the model
three weakly-related snippets is worse than handing it none, because it treats
whatever it is given as relevant. Retrieval failures are non-fatal — answering
without remembered context beats not answering.

`EMBEDDING_DIM` is substituted into the migration at apply time. Changing the
embedding model changes the dimension, which means a new migration and a
re-embed of every row. Pick the model before you fill the table.

### Tools come from three places, behind one interface

| Source | Where it comes from | Who wrote the description |
|---|---|---|
| `builtin` | Code in the orchestrator | Us |
| `mcp` | Any MCP server in the registry | The server |
| `connector` | The tool registry UI | You |

The agent sees one flat list. Connector tools are rebuilt from the database on
every turn, so a service you register in the UI is usable immediately — no
restart. The description you type is what the model matches "check Stripe"
against, which is why it's a required field with a minimum length: it is a tool
description, not a label.

Every invocation is written to `tool_invocations` — arguments, outcome,
duration. That is the audit trail for "what did the agent actually do".

### Credentials

`MASTER_KEY` (32 bytes) encrypts every stored credential with AES-256-GCM in a
versioned envelope (`v1.<iv>.<tag>.<ciphertext>`). Credentials are write-only
through the API: they arrive as plaintext over TLS, are encrypted before they
reach the database, and no read path returns them — the API reports
`hasCredential: true` and nothing else. Decryption happens at call time, inside
the connector tool, and the value never enters a log line or an error message.

Rotating `MASTER_KEY` makes existing credentials unreadable. There is no
re-encryption path yet; that is a gap worth closing before you store anything
you can't re-issue.

### Notification policy

The build plan called this out and it is the single most important guard in the
system: a false-positive series from the email classifier must not be able to
call you forty times.

- **Quiet hours** block non-urgent calls, and handle the midnight wrap
  (22:00–07:00 is *not* `start <= now <= end`).
- **Budget** — calls per hour and per day — binds *even for urgent calls*.
  Urgency overrides quiet hours; nothing overrides the budget.
- **Blocked attempts don't consume budget** and are logged with their reason, so
  a storm is visible in `call_logs` and costs nothing.
- **The model cannot declare its own request urgent.** The `urgent` flag bypasses
  quiet hours and is reserved for operator-triggered calls; the built-in tool
  hardcodes `urgent: false`.

The same shape applies to LLM spend: a per-minute call ceiling in the router and
a per-turn step ceiling in the agent loop. An agent stuck in a tool loop hits
the ceiling and stops.

### Service-to-service auth

Every internal caller presents `SERVICE_TOKEN` as a bearer token, compared in
constant time. This is the floor, not the ceiling: the PC daemon gets its own
per-daemon token, and mTLS is the intended hardening step
(see [pc-daemon-protocol.md](pc-daemon-protocol.md)). What matters today is that
nothing but `/health` is reachable unauthenticated.

## What is deliberately not built yet

The voice pipeline, email monitor, channel adapters and PC daemon are specified
but absent. Where the orchestrator would call them, it records the intent and
says so plainly — `CallService` writes a `call_logs` row and logs "voice
pipeline not configured" rather than pretending a call happened. The behaviour
is observable end to end; only the last hop is missing.

See [roadmap.md](roadmap.md) for the order and the open decisions.
