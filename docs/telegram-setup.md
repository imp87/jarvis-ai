# Telegram adapter — setup

Two independent things have to be in place: the **speech models** (local by
default) and **public reachability** for the webhook. The adapter runs in a
development polling mode without the second one, so you can get the bot working
before touching the router.

---

## 1. Bot

1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token into
   `TELEGRAM_BOT_TOKEN`.
2. `/setprivacy` → **Disable** is *not* needed: the bot only ever reads direct
   messages, and group privacy mode can stay on.
3. Find your own numeric Telegram user id (e.g. via [@userinfobot](https://t.me/userinfobot)) —
   this is the `channelUserId` you register. It is a number, not your @username.

Register yourself; nobody else can talk to the bot:

```bash
TOKEN=...  # SERVICE_TOKEN from .env
USER_ID=$(curl -s -X POST localhost:18780/v1/users \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"displayName":"Steve","isOwner":true}' | jq -r .id)

curl -X POST localhost:18780/v1/identities \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"channel\":\"telegram\",\"channelUserId\":\"<your numeric id>\"}"
```

Reply format (text is the default — this is a stored setting, **not** mirrored
from whether you sent a voice note):

```bash
curl -X PUT "localhost:18780/v1/users/$USER_ID/settings/telegram" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"replyFormat":"voice","language":"de"}'
```

---

## 2. Speech models

**STT needs no install.** Whisper runs in-process through transformers.js; the
weights download on first use and are cached. Measured on a desktop CPU:
~1.3 s to load, ~1 s per 5 s of audio with `Xenova/whisper-base`. The adapter
loads the model at startup so the first voice note isn't slow.

**In Docker there is nothing to install.** The adapter image bakes in the Linux
Piper build and the German voice (~90 MB), with `PIPER_BINARY` and `PIPER_MODEL`
defaulted to match. Compose deliberately does not pass the host's `PIPER_*`
values through: those are host paths for running natively, and a host path
inside a container is exactly how this breaks. Override `PIPER_ARCH=aarch64` as
a build argument for a Raspberry Pi, or `PIPER_VOICE_URL` for a different voice.

**Running natively, TTS needs Piper installed**, because it is the only local
engine with a genuinely good German voice. Two downloads:

```bash
sudo mkdir -p /opt/piper && cd /opt/piper

# Binary — pick the build for your platform from the releases page
curl -L -o piper.tar.gz \
  https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
sudo tar xzf piper.tar.gz --strip-components=1

# German voice (Thorsten, medium quality — ~63 MB)
BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/medium
sudo curl -L -O $BASE/de_DE-thorsten-medium.onnx
sudo curl -L -O $BASE/de_DE-thorsten-medium.onnx.json
```

Then set `PIPER_BINARY`, `PIPER_MODEL` and `PIPER_SAMPLE_RATE=22050`. The
adapter checks both paths at startup and refuses to run if either is missing.

**Verified inside the `node:24-slim` container** (the adapter's base image):
every shared library the Piper release needs resolves without installing extra
Debian packages, and synthesis runs at a real-time factor of ~0.05 — roughly 19×
faster than playback. Linux is Piper's primary target and is noticeably faster
than the Windows build.

> **Extract the Linux tarball on Linux.** It contains symlinks
> (`libespeak-ng.so` → `libespeak-ng.so.1`), which Windows refuses to create
> without elevated privileges — `tar` fails halfway and leaves an unusable
> directory. Download and unpack on the server, or inside a container.

The voice model (`.onnx` + `.onnx.json`) is platform-independent: the same files
work on Windows, Linux and a Raspberry Pi.

### Whisper model cache

The first transcription downloads ~280 MB of weights. `WHISPER_CACHE_DIR` must
point at persistent storage, or every container restart re-downloads them.
Compose already mounts the `speech-models` volume at `/models` for this.

Measured in the container: **20.4 s cold, 2.5 s warm.** The adapter loads the
model at startup, so the cost lands on boot rather than on the first voice note.

> The `.onnx.json` must sit next to the `.onnx`; Piper reads the sample rate and
> phoneme map from it. `PIPER_SAMPLE_RATE` must match the `audio.sample_rate`
> field inside that JSON, since Piper writes headerless PCM and does not report
> its rate.

If you would rather not run local speech, set `STT_ENGINE=openai` and
`TTS_ENGINE=openai` and supply `OPENAI_API_KEY`. Voice notes then leave the
machine — a deliberate choice, which is why it is not the default.

---

## 3. Reachability: polling or webhook

**The current deployment uses polling, and that is a deliberate choice.**

### 3.1 The constraint that decides this

Telegram delivers webhooks to **four ports only**. Verified against the live API:

```
$ curl -X POST .../setWebhook -d '{"url":"https://example.de:6892/hook", ...}'
{"ok":false,"error_code":400,
 "description":"Bad Request: bad webhook: Webhook can be set up only on ports 80, 88, 443 or 8443"}
```

This connection is **DS-Lite**: no public IPv4, and the ISP's port-forwarding
product assigns a fixed range (currently 6892–6911). None of those are 80, 88,
443 or 8443, so a webhook pointed at the home IPv4 is rejected by Telegram
before a single packet is sent. No amount of DynDNS or certificate work changes
that.

The adapter validates this at startup so the failure is a clear config error
rather than a confusing `setWebhook` rejection.

### 3.2 Polling — what is running now

```bash
TELEGRAM_MODE=polling
```

No inbound reachability at all: no DynDNS, no port forward, no certificate, no
firewall exposure. The adapter opens an outbound long-poll and Telegram answers
it the moment a message arrives.

The trade-offs are real but small here:

| | Impact |
|---|---|
| Latency | Negligible — `getUpdates` returns immediately on a new message, it does not wait out the timeout |
| Scaling | Only one process may poll a given bot. Fine for a personal agent, wrong for a fleet |
| Connections | One long-lived outbound request, re-opened every 30 s |
| Restart | The update offset lives in memory, so a restart may re-fetch a message Telegram still has queued |

For a single-user personal agent none of these matter. Polling is not a
downgrade from webhook here — it is the mode that fits the network.

### 3.3 If you want a webhook later

Three routes, in order of how well they fit the stated principles:

**a) Through your own Hetzner VPS (recommended when a Mini-PC exists).**
The VPS has a public IPv4 and already runs Nginx Proxy Manager. Terminate TLS
there on 443, and forward to the home machine over a WireGuard link. This is not
a third-party tunnel — it is your own server, which was the actual objection to
Cloudflare Tunnel. Cost: a VPN to maintain, and reachability now depends on
Hetzner being up.

**b) IPv6.** DS-Lite gives you native, unrestricted IPv6 — the port limitation
only applies to the shared IPv4. An AAAA record plus an IPv6 firewall rule for
port 443 would work *if* Telegram delivers over IPv6. **Unverified**: test it
with a throwaway endpoint before building on it. If it does work, note that
`TELEGRAM_IP_ALLOWLIST` must be set to `false`, because that check only
understands IPv4 and would drop every delivery.

**c) Ask the ISP for a public IPv4.** Often available on request, sometimes for
a small fee. Restores the original DynDNS plan in full.

### 3.4 If you switch to webhook

```bash
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_URL=https://jarvis.example.de   # port must be 80, 88, 443 or 8443
TELEGRAM_WEBHOOK_PATH=/telegram/webhook-<random>
TELEGRAM_WEBHOOK_SECRET=<32+ chars, A-Za-z0-9_- only>
```

The adapter registers the webhook itself at startup and logs `getWebhookInfo`.
A populated `last_error_message` means Telegram reached something it did not
like — usually a certificate problem or a 404 from a mismatched path.

Whatever terminates TLS must be the only thing listening on 80/443; the adapter
and orchestrator bind to loopback. On a Linux host:

```bash
sudo ufw default deny incoming
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
sudo ss -tlnp | grep -v 127.0.0.1   # nothing unexpected should appear
```

---

## 4. Security summary

The endpoint is on the open internet, so four things guard it:

1. **Secret token** — Telegram echoes `TELEGRAM_WEBHOOK_SECRET` in the
   `X-Telegram-Bot-Api-Secret-Token` header on every delivery; it is compared in
   constant time. This is the real authenticity check.
2. **IP allowlist** — deliveries from outside `149.154.160.0/20` and
   `91.108.4.0/22` are dropped before the body is parsed. Defence in depth:
   Telegram has changed these ranges before, and IPv6 deliveries fail it, which
   is why it is not the primary gate.
3. **Rate limit** — 120 requests/minute. Over the limit still returns 200, so
   Telegram does not queue retries into a bigger backlog.
4. **Identity gate** — the orchestrator resolves the sender before any work
   happens. An unregistered id gets an explicit refusal, and critically the
   adapter checks this *before* downloading or transcribing audio, so a stranger
   cannot make you spend compute.

Body size is capped at 1 MB and voice downloads at `MAX_VOICE_BYTES` (20 MB).

---

## 5. Development mode

Before the network side exists:

```bash
TELEGRAM_MODE=polling NODE_ENV=development pnpm --filter @jarvis/telegram-adapter dev
```

The adapter deletes any registered webhook and long-polls instead. It refuses to
start in polling mode when `NODE_ENV=production`, so this cannot ship by accident.
