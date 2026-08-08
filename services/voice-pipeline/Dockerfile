# Build context is the repo root — the service depends on workspace packages.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# Piper is baked in for the same reason as in the Telegram adapter: an image
# that depends on a host-mounted binary only works on hosts that happen to have
# the right one.
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
 && test -x /opt/piper/piper \
 && test -s "/opt/piper/${PIPER_VOICE}.onnx"

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/speech/package.json packages/speech/
COPY services/voice-pipeline/package.json services/voice-pipeline/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @jarvis/voice-pipeline...

COPY packages/shared packages/shared
COPY packages/speech packages/speech
COPY services/voice-pipeline services/voice-pipeline
RUN pnpm --filter @jarvis/voice-pipeline... run build
RUN pnpm --filter @jarvis/voice-pipeline --prod --legacy deploy /deploy

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /deploy /app
COPY --from=piper /opt/piper /opt/piper

ENV PIPER_BINARY=/opt/piper/piper
ENV PIPER_MODEL=/opt/piper/de_DE-thorsten-medium.onnx
ENV PIPER_SAMPLE_RATE=22050
ENV WHISPER_CACHE_DIR=/models/whisper
ENV ASTERISK_SPOOL_DIR=/var/spool/asterisk/outgoing
ENV ASTERISK_STAGING_DIR=/var/spool/asterisk/staging

# The spool is shared with Asterisk. Staging lives on the same filesystem so the
# move into the spool is atomic — Asterisk polls that directory and would read a
# half-written call file.
RUN mkdir -p /models/whisper /var/spool/asterisk/outgoing /var/spool/asterisk/staging \
 && chown -R node:node /models /var/spool/asterisk

USER node
EXPOSE 8082 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8082/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
