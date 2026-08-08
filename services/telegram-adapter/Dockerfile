# Build context is the repo root — the service depends on workspace packages.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

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

# Model cache lives on a volume; create it owned by the runtime user.
RUN mkdir -p /models/whisper && chown -R node:node /models

USER node
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8081/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
