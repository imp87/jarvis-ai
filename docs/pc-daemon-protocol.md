# PC control daemon — wire protocol

Specification only. Implementation is [phase 6](roadmap.md#phase-6--pc-control-daemon).
The Zod schemas are authoritative and live in
[`packages/shared/src/protocols/daemon.ts`](../packages/shared/src/protocols/daemon.ts);
this document explains the reasoning.

## Connection model

The daemon dials **out** to `wss://<orchestrator>/v1/daemon` over TLS and keeps
the socket open. Your PC never opens an inbound port and never needs a
port-forward or a static address.

```
PC daemon  ──── wss (outbound, TLS) ────▶  orchestrator
           ◀─── requests over the same socket
```

Auth: the daemon presents a per-daemon token in its `hello` frame, compared in
constant time. This is intentionally a *different* token from `SERVICE_TOKEN` —
a leaked daemon token must not grant access to the rest of the API, and revoking
one daemon must not lock out every adapter. mTLS is the intended hardening step
once there's a CA to issue from.

## Capabilities, not commands

The daemon never receives free-form shell input. Every action is a **named
capability** the daemon has declared and the server has granted:

| Capability | Risk | Default |
|---|---|---|
| `screen.capture` | read-only | on |
| `file.read` (under a configured root) | read-only | on |
| `script.run` (from the daemon's local allowlist) | mutating | on |
| `shell.open` | mutating | on |
| `input.control` (synthetic mouse/keyboard) | high | **off** |

The granted set is the intersection of what the daemon offers and what server
policy permits, so both ends can restrict independently. The blast radius is the
allowlist, not "whatever the model decided to type".

## Approval modes

Every request carries an `approval` mode decided server-side:

- `auto` — execute immediately. Read-only capabilities only.
- `confirm` — the daemon shows a **local** prompt and waits for a human. The
  approval happens on the machine being controlled, not in the orchestrator,
  because that is where someone can actually see what is about to happen.
- `plan` — do not execute; report what *would* happen. This is what makes
  "screenshot, analyse, tell me what to click" a first-class mode rather than a
  degraded one.

`reason` is a required human-readable string and is what the confirm prompt
shows. A request the user can't understand is a request they can't meaningfully
approve.

## Frames

Daemon → server: `hello`, `result`, `heartbeat`.
Server → daemon: `welcome`, `request`, `error`.

Every `request` carries a `requestId` (UUID) echoed in its `result`, plus a
`timeoutMs` capped at 120 s. `heartbeat` carries a monotonic `sequence` so the
server can detect a restarted daemon rather than a merely slow one.

Errors are typed: `unauthorized`, `protocol_version_mismatch`,
`capability_denied`, `rate_limited`, `internal`. `rate_limited` carries
`retryAfterSeconds`, and the daemon must respect it — an aggressive reconnect
loop against a rate-limited server is a self-inflicted outage.

`protocolVersion` is checked on `hello` and mismatches are rejected outright.
Negotiating down means supporting every past shape forever; refusing is honest
and the failure message says exactly what to upgrade.

## Open questions for the implementation phase

- Where the daemon's script allowlist lives (local config file, or synced from
  the server with local override — local wins either way)
- Whether `file.read` roots are configured on the daemon, the server, or both
- Screenshot handling: raw base64 over the socket is simple but large; an upload
  URL scales better
