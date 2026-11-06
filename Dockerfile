# ============================================================================
# AbrIT backend — multi-stage build (review round 6, P1 deployment infra)
#   build : npm ci → nest build            (dev deps included)
#   run   : production deps only, non-root, healthcheck on /api/health/live
# Configuration is 100% via environment variables (see .env.production.example).
# The container runs MIGRATIONS_RUN-controlled migrations at boot — exactly one
# backend instance may run at a time (see docs/DEPLOYMENT.md).
# ============================================================================

# --- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# --- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# dumb-init gives the node process proper PID-1 signal handling (SIGTERM →
# graceful stop: telegraf polling stops, pending queries drain, exit 0).
RUN apk add --no-cache dumb-init wget

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

# Non-root: the container never needs privileges.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Liveness only (no external dependency) — readiness is probed by compose/ops.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health/live" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
