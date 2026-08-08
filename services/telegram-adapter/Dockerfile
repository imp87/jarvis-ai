# Build context is the repo root — the service depends on workspace packages.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# Piper (local German TTS) is baked into the image rather than mounted.
#
# Mounting it from the host means the image only works on a host that happens
# to have the right binary at the right path — a Windows dev machine mounts a
# .exe into a Debian container and the service dies at startup. Baking it in
# makes the image self-contained and identical on every host, at the cost of
# roughly 90 MB.
#
# Override PIPER_ARCH for arm64 (e.g. a Raspberry Pi), or PIPER_VOICE_URL for a
# different voice. Extra voices can still be mounted at runtime via
# PIPER_VOICES_DIR.
# ---------------------------------------------------------------------------
FROM base AS piper
ARG PIPER_VERSION=2023.11.14-2
ARG PIPER_ARCH=x86_64
ARG PIPER_VOICE=de_DE-thorsten-medium
ARG PIPER_VOICE_URL=https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${PIPER_ARCH}.tar.gz" \
      | tar xz -C /opt \
 && curl -fsSL -o "/opt/piper/${PIPER_VOICE}.onnx"      "${PIPER_VOICE_URL}" \
 && curl -fsSL -o "/opt/piper/${PIPER_VOICE}.onnx.json" "${PIPER_VOICE_URL}.json" \
 # Fail the build rather than the container: a voice model that did not
 # download leaves a service that starts and then cannot speak.
 && test -x /opt/piper/piper \
 && test -s "/opt/piper/${PIPER_VOICE}.onnx"

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/speech/package.json packages/speech/
COPY services/telegram-adapter/package.json services/telegram-adapter/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @jarvis/telegram-adapter...

COPY packages/shared packages/shared
COPY packages/speech packages/speech
COPY services/telegram-adapter services/telegram-adapter
RUN pnpm --filter @jarvis/telegram-adapter... run build

RUN pnpm --filter @jarvis/telegram-adapter --prod --legacy deploy /deploy

FROM base AS runtime
ENV NODE_ENV=production
# Debian rather than Alpine: onnxruntime-node (local Whisper) ships glibc
# binaries and does not run against musl.
COPY --from=build /deploy /app
COPY --from=piper /opt/piper /opt/piper

# Defaults matching the baked-in install, so the service runs with no
# speech-related configuration at all.
ENV PIPER_BINARY=/opt/piper/piper
ENV PIPER_MODEL=/opt/piper/de_DE-thorsten-medium.onnx
ENV PIPER_SAMPLE_RATE=22050
ENV WHISPER_CACHE_DIR=/models/whisper

# Model cache lives on a volume; create it owned by the runtime user.
RUN mkdir -p /models/whisper && chown -R node:node /models

USER node
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8081/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
