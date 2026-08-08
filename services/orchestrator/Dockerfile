# Build context is the repo root — the service depends on workspace packages.
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS build
# Manifests first so the install layer is cached until a dependency changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/llm/package.json packages/llm/
COPY packages/mcp/package.json packages/mcp/
COPY services/orchestrator/package.json services/orchestrator/
# `...` pulls in the workspace dependencies of the orchestrator and nothing else,
# so @jarvis/speech (only the Telegram adapter needs it) stays out of this image.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @jarvis/orchestrator...

COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/llm packages/llm
COPY packages/mcp packages/mcp
COPY services/orchestrator services/orchestrator
RUN pnpm --filter @jarvis/orchestrator... run build

# Collect the production runtime closure for just this service.
RUN pnpm --filter @jarvis/orchestrator --prod --legacy deploy /deploy

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /deploy /app
# Migrations are plain .sql files and are not part of the TypeScript build output.
COPY --from=build /app/packages/db/migrations /app/node_modules/@jarvis/db/migrations

# Never run the agent as root: it executes model-chosen tool calls.
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
