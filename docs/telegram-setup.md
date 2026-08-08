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
USER_ID=$(curl -s -X POST localhost:8080/v1/users \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"displayName":"Steve","isOwner":true}' | jq -r .id)

curl -X POST localhost:8080/v1/identities \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"channel\":\"telegram\",\"channelUserId\":\"<your numeric id>\"}"
```

Reply format (text is the default — this is a stored setting, **not** mirrored
from whether you sent a voice note):

```bash
curl -X PUT "localhost:8080/v1/users/$USER_ID/settings/telegram" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"replyFormat":"voice","language":"de"}'
```

---

## 2. Speech models

**STT needs no install.** Whisper runs in-process through transformers.js; the
weights download on first use and are cached. Measured on a desktop CPU:
~1.3 s to load, ~1 s per 5 s of audio with `Xenova/whisper-base`. The adapter
loads the model at startup so the first voice note isn't slow.

**TTS needs Piper**, because it is the only local engine with a genuinely good
German voice. Two downloads:

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

> The `.onnx.json` must sit next to the `.onnx`; Piper reads the sample rate and
> phoneme map from it. `PIPER_SAMPLE_RATE` must match the `audio.sample_rate`
> field inside that JSON, since Piper writes headerless PCM and does not report
> its rate.

If you would rather not run local speech, set `STT_ENGINE=openai` and
`TTS_ENGINE=openai` and supply `OPENAI_API_KEY`. Voice notes then leave the
machine — a deliberate choice, which is why it is not the default.

---

## 3. Public reachability (webhook)

Telegram delivers over HTTPS to a public address. The chosen route is DynDNS on
the FritzBox plus a port forward, rather than a third-party tunnel, so
reachability does not depend on someone else's service.

### 3.1 Check for CGNAT / DS-Lite first

**Do this before anything else.** Many German connections no longer hand out a
public IPv4; port forwarding then silently does nothing.

FritzBox → *Internet → Online-Monitor*. If the shown IPv4 starts with `100.64.`
– `100.127.`, or the connection is labelled DS-Lite, you have no public IPv4.
Options: ask your ISP for a public IPv4 (often free on request), or run the
webhook over IPv6 only — but then the `TELEGRAM_IP_ALLOWLIST` check must be
turned off, because it only understands IPv4.

### 3.2 DynDNS

FritzBox → *Internet → Freigaben → DynDNS → Benutzerdefiniert*. You need a
domain whose DNS provider offers an update URL — desec.io, dynv6 and Cloudflare
all work. Enter the update URL, domain, username and password from that provider.

Verify from outside your network that the name resolves to your current IP.

### 3.3 Port forwarding

FritzBox → *Internet → Freigaben → Portfreigaben*, forwarding to the Mini-PC:

| Port | Why |
|---|---|
| 443 | Telegram delivers here |
| 80 | Let's Encrypt HTTP-01 challenge (can be closed afterwards if you switch to DNS-01) |

### 3.4 TLS via a local Nginx Proxy Manager

Run a second NPM instance on the Mini-PC — the one on Hetzner cannot issue a
certificate for a name that points at your home IP. Add a proxy host for your
DynDNS name forwarding to `127.0.0.1:8081`, and request a Let's Encrypt
certificate for it.

**Firewall:** only NPM may listen on 80 and 443. The adapter and the
orchestrator bind to loopback and are reachable only through the proxy. On the
Mini-PC:

```bash
sudo ufw default deny incoming
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Verify nothing else is exposed: `sudo ss -tlnp | grep -v 127.0.0.1`.

### 3.5 Switch the adapter to webhook mode

```bash
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_URL=https://jarvis.example.de
TELEGRAM_WEBHOOK_PATH=/telegram/webhook-<random>
TELEGRAM_WEBHOOK_SECRET=<32+ chars, A-Za-z0-9_- only>
```

The adapter registers the webhook itself at startup and logs
`getWebhookInfo`. If `last_error_message` is populated, Telegram is reaching
something it doesn't like — usually a certificate problem or a 404 from a
mismatched path.

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
