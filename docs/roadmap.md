# Roadmap

Ordered as agreed in the build plan. Each phase is independently useful; nothing
below phase 1 is required for the phase above it to work.

## Phase 1 — Core Agent Orchestrator ✅ done

LLM provider abstraction (Anthropic / OpenAI / Ollama) with config-driven
routing, Postgres + pgvector, MCP client layer, tool registry backend, agent
loop with tool calling, REST API, policy layer.

Verified against a live pgvector Postgres: migrations, identity gate, vector
search with threshold and kind filters, credential encryption at rest, call
budget accounting, connector registration appearing as a tool without restart,
auth rejection. Unit tests cover the policy and crypto logic.

## Phase 2 — Telegram adapter incl. voice notes ⭐ in progress

Reordered ahead of the UI: this is the primary interaction path, since there is
no wake-word device.

- Bot API via webhook (no polling)
- Voice notes in: download `.ogg` → STT → normal inbound message
- Voice notes out: reply → TTS → send as voice note, driven by a per-user setting
  that is configurable through the admin UI, not mirrored from the input format
- **STT/TTS ship as a shared `packages/speech`, not inside the adapter.** The
  voice-call pipeline and any future wake-word client need exactly the same two
  operations; implementing them per channel means three copies to keep in sync.
- Reachability via **long polling**, not a webhook. The connection is DS-Lite
  and the ISP's forwarded port range (6892–6911) contains none of the four ports
  Telegram will deliver to (80, 88, 443, 8443), verified against the live API.
  See [docs/telegram-setup.md](telegram-setup.md#3-reachability-polling-or-webhook).

Discord follows as the second adapter — same interface, mechanical work.

## Phase 3 — Tool Registry UI (Next.js)

Backend is done and exercised over HTTP; this is the front end.

- Connector form: name, description, base URL, auth method, credential
- Endpoint editor, plus optional OpenAPI import to derive endpoints
- MCP server management (the `/v1/mcp/*` endpoints already exist)
- Per-user channel settings, including the text-vs-voice reply format that
  phase 2 stores in the database
- Log views: conversations, tool invocations, call log

## Phase 4 — E-mail monitoring

- Gmail via API (OAuth) or an existing Gmail MCP server — worth checking the
  current state of the MCP registry first, since the generic MCP layer already
  exists and a ready server means no bespoke code
- Push notifications via Cloud Pub/Sub rather than polling
- Classification → importance score → threshold → notify or call
- The rate limiting and quiet hours this needs are **already implemented** and
  tested; this phase wires into them rather than inventing its own

## Phase 5 — Voice call pipeline

**Decided: register against the FritzBox, not an external SIP trunk.** There is
a FritzBox in the home network with three active numbers and its own SIP
registrar. The pipeline registers as an IP telephone (FritzBox UI: *Telefonie →
Telefoniegeräte → neues Gerät → LAN/WLAN-Telefon*), gets its own extension and
one of the existing numbers, and places calls through it.

This supersedes the earlier plan to evaluate Telnyx / sipgate trunking. No
external SIP provider, no per-minute contract with a third party, no US
platform in the call path — the numbers are already there.

Consequences worth stating explicitly, because they constrain other phases:

- **The pipeline must run on a Mini-PC in the home network.** A FritzBox SIP
  registrar is reachable on the LAN only; a component on Hetzner cannot register
  against it without a VPN back home, which reintroduces exactly the dependency
  this avoids.
- **Calls cannot survive a home outage.** If the flat loses power or internet,
  the registrar is gone and no call can be placed regardless of where the rest
  of the system runs. This resolves a tension in the old hybrid argument — see
  [Open decision 1](#1-deployment-all-local-vs-hybrid).
- The FritzBox limits how many devices may register and how many concurrent
  calls run over one number; worth checking against the actual model before
  assuming a second parallel call is possible.
- Still to determine at implementation time: whether Pipecat or LiveKit Agents
  is the better fit for a plain SIP registration (rather than a trunk), and
  whether an intermediate Asterisk/baresip is needed as the SIP endpoint.

**Calls go both ways.** Beyond the original brief's outbound calls, the agent
should also be reachable *by* phone: dialling its FritzBox extension starts a
conversation. Registering as an IP telephone gives this almost for free — the
extension can receive as well as place calls — but it doubles the surface:
an inbound call needs answering, identifying the caller (anyone who can dial the
number reaches it), and its own session handling. Speaker verification
(phase 7) is what would eventually make that safe.

The trigger side already exists: `POST /v1/actions/call` and the
`place_phone_call` tool run the full policy check and write the call log. What
is missing is the last hop — `VOICE_PIPELINE_URL` and something listening on it.

## Phase 6 — PC control daemon

Protocol is specified ([pc-daemon-protocol.md](pc-daemon-protocol.md)) and its
schemas ship in `@jarvis/shared`. Implementation deferred.

Recommendation, since the plan asked for one: **start with option B (narrow
remote actions), not option A (full computer use).** The narrow version —
screenshot, analyse, give instructions, run allowlisted scripts — covers most of
"ich komme nicht weiter, übernimm" at a fraction of the risk, and it is the
subset you'd want to keep anyway once you have full control available. The
protocol supports both: `input.control` is a capability like any other, off by
default, and the `approval: confirm | plan` modes exist precisely so full
control can be added later without redesigning anything.

## Phase 7 — Wake word + speaker ID (optional, deferred)

No dedicated always-listening device exists, so this is parked. When a Pi is set
up for it: check whether Home Assistant Assist (with openWakeWord) can be the
front end and forward intents to this agent — that saves building the entire
wake-word/STT stack. Speaker verification (pyannote / SpeechBrain) stores an
embedding in the same pgvector table that already exists.

---

## Open decisions

### 1. Deployment: all-local vs hybrid — effectively decided by phases 2 and 5

Two later decisions have collapsed this question:

- **Phase 5 puts the voice pipeline at home.** The FritzBox SIP registrar is
  LAN-only, so calls are impossible during a home outage no matter where the
  orchestrator runs. The strongest argument for hybrid was "the agent must still
  be able to call me when the power is out at home" — with a FritzBox registrar
  that guarantee cannot be delivered at any price.
- **Phase 2 needs no inbound reachability at all.** DS-Lite plus an ISP port
  range that excludes every port Telegram accepts killed the DynDNS webhook
  plan; the adapter long-polls instead. That removes reachability as an argument
  in either direction — polling works identically at home or on Hetzner.

That makes **all-local on the Mini-PC** the coherent answer, and hybrid mostly
pointless: it would add a VPN and a second host while still failing on exactly
the outage it was meant to survive.

What is lost, stated plainly: during a home power or internet outage the agent
is fully offline — no chat, no calls, and inbound Telegram messages are queued
by Telegram rather than lost, but nothing is processed until you are back.
Accepting that is the price of not depending on a third-party tunnel.

Still open: whether Postgres also lives on the Mini-PC (simplest, consistent
with the above) or stays on Hetzner as a hedge against losing local disk. The
former is recommended; backups belong to the host either way.

### 2. Embedding model — decide before filling the memory table

`EMBEDDING_DIM` is baked into the migration. Changing it later means a new
migration plus re-embedding everything. Currently defaulted to OpenAI
`text-embedding-3-small` (1536). If memory should also work without a cloud
dependency, `nomic-embed-text` on Ollama (768) is the local option — decide now,
while the table is empty.

### 3. Master key rotation

There is no re-encryption path. Rotating `MASTER_KEY` orphans stored
credentials. Worth adding before storing anything that can't simply be re-issued.
