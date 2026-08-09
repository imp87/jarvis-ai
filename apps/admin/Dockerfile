# Build context is the repo root — this is a workspace package.
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS build
# Manifests first so the install layer is cached until a dependency changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json ./
COPY apps/admin/package.json apps/admin/
# The admin UI talks to the orchestrator over HTTP only — it shares no workspace
# packages, so nothing else needs to be in this image.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @jarvis/admin...

COPY apps/admin apps/admin
# Telemetry would phone home from a machine whose whole point is not depending
# on anyone else's platform.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @jarvis/admin run build

FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# `output: "standalone"` already traced the exact runtime closure, so there is
# no install step here and no node_modules to copy wholesale.
COPY --from=build /app/apps/admin/.next/standalone ./
COPY --from=build /app/apps/admin/.next/static ./apps/admin/.next/static

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/admin/server.js"]
