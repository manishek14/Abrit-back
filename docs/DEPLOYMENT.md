# Production Deployment Guide

This guide answers the deployment questions the architecture left open: where
the backend runs, how the frontend is served, how HTTPS and the WebSocket work,
how the database is backed up, and what happens after a server restart.

## 1. Topology

```
                        ┌──────────────────────────── host (single VM) ────────────────────────────┐
 browser ── HTTPS ──▶ 80/443 │ frontend (nginx)                                                     │
                             │   • serves the built SPA (static, hashed assets, gzip)               │
                             │   • /api/*       → backend:3000   (REST)                             │
                             │   • /socket.io/* → backend:3000   (WebSocket, upgrade supported)     │
                             │                                        backend (node, non-root)      │
                             │                                          │ migrations on boot        │
                             │                                          ▼                          │
                             │                                        db (postgres:16-alpine)      │
                             │                                          ▲                          │
                             │                            db-backup (profile "backup")             │
                             └──────────────────────────────────────────────────────────────────────┘
```

Everything ships in this repository:

| Piece | File | Purpose |
|---|---|---|
| Backend image | `backend/Dockerfile` | multi-stage build, non-root, dumb-init, liveness healthcheck |
| Frontend image | `frontend/Dockerfile` | vite build → nginx runtime |
| Reverse proxy | `frontend/nginx.conf` | static SPA + `/api` + `/socket.io` proxying (WebSocket upgrade headers included) |
| Orchestration | `docker-compose.prod.yml` | db + backend + frontend (+ optional `db-backup` profile) |
| Env template | `.env.production.example` | every production variable with generation hints |

## 2. Prerequisites

- A Linux host with Docker Engine + the compose plugin (v2.20+).
- A domain name pointing at the host (needed for the Telegram webhook and TLS).
- Outbound internet for the backend (Telegram API, optionally OpenRouter).

## 3. First deployment

```bash
# on the server, inside the repo
cp .env.production.example .env.production
# EDIT .env.production: JWT_SECRET, POSTGRES_PASSWORD, ADMIN_PASSWORD,
# CORS_ORIGIN, TELEGRAM_* (see the hints inside the file)

docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build

# verify
docker compose -f docker-compose.prod.yml --env-file .env.production ps
curl -fsS http://127.0.0.1/api/health/live      # → {"status":"ok",...}
curl -fsS http://127.0.0.1/api/health/ready     # → {"status":"ok","db":"up",...}
```

Order of operations is handled by compose: `db` starts and passes its
healthcheck → `backend` boots (runs pending migrations via `MIGRATIONS_RUN=true`,
refuses to start on a broken config or a failed Telegram bootstrap) →
`frontend` starts once the backend reports **liveness + healthcheck-ok**.

The admin account is created on first boot from `ADMIN_EMAIL` /
`ADMIN_PASSWORD` (production refuses the default/weak passwords — the same
validation that runs in CI).

## 4. HTTPS

The bundled nginx listens on **:80**; TLS is terminated in ONE of two supported
ways — pick one:

**Option A (recommended): TLS at an upstream load balancer / CDN.**
Put the host behind a TLS-terminating LB (cloud LB, Cloudflare, Caddy…). The LB
forwards plain HTTP to :80 and honors `X-Forwarded-Proto`. Requirements:

- Forward **both** `/api/*` and `/socket.io/*` (or simply `/` — nginx handles
  the split).
- Do NOT buffer the WebSocket route (LB WebSocket support is default on all
  major LBs).
- The backend reads `X-Forwarded-Proto` only for logging; cookies are
  `Secure` + `SameSite=Strict`, which works over any HTTPS front.

**Option B: certificates on the host nginx.** Mount certs into the frontend
container and REPLACE the default proxy config with the TLS variant:

```yaml
# docker-compose.prod.yml → frontend.volumes
      - ./certs/fullchain.pem:/etc/nginx/certs/fullchain.pem:ro
      - ./certs/privkey.pem:/etc/nginx/certs/privkey.pem:ro
      - ./deploy/nginx-tls.conf:/etc/nginx/conf.d/default.conf:ro
```

```bash
# get a certificate (certbot standalone, stop nginx first)
docker compose -f docker-compose.prod.yml --env-file .env.production stop frontend
certbot certonly --standalone -d your-domain.example
cp /etc/letsencrypt/live/your-domain.example/{fullchain.pem,privkey.pem} certs/
docker compose -f docker-compose.prod.yml --env-file .env.production up -d frontend
```

Renewals: re-run the certbot command monthly (a cron/systemd timer), then
`docker compose ... restart frontend`. In production (`NODE_ENV=production`)
session cookies are `Secure` automatically — plain HTTP login attempts will not
receive a cookie, which is intentional.

## 5. WebSocket through the reverse proxy

The panel's realtime channel is socket.io on `/socket.io/`. The bundled
`frontend/nginx.conf` already contains the mandatory bits — if you replace the
proxy, keep them:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 1h;      # survive idle tabs (socket.io heartbeats every 25 s)
```

The WebSocket authenticates with the SAME HttpOnly session cookie as the REST
API (the browser attaches it to the handshake); the gateway additionally
enforces the CORS origin allowlist (`CORS_ORIGIN`).

## 6. Database

### Migrations (controlled, reviewed)

- `synchronize` is **hard-coded false** — schema changes only through
  `backend/src/database/migrations/*`.
- `MIGRATIONS_RUN=true` (default) applies pending migrations at boot, before
  the API accepts traffic. Migrations are idempotent (TypeORM migration table).
- Policy: migrations run in the deployment step — compose starts a NEW backend
  container, the new code migrates, then serves. One instance = no concurrent
  migrators.
- Manual control: set `MIGRATIONS_RUN=false` and run them explicitly:
  `docker compose -f docker-compose.prod.yml --env-file .env.production exec backend node -e "…"`,
  or locally `npm run migration:run` against the production URL.

### TLS to a managed PostgreSQL

If you use a hosted PostgreSQL instead of the bundled `db` service:

```env
DATABASE_URL=postgres://user:pass@host:5432/abrit?sslmode=require
DATABASE_SSL=true          # or rely on sslmode above
DATABASE_SSL_CA=<PEM body> # optional: pins the server certificate (recommended)
```

### Backup & retention

Automated (opt-in sidecar):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production --profile backup up -d
# nightly pg_dump into ./backups on the host, KEEP_DAYS (default 14) retention
```

Manual:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec db \
  pg_dump -U abrit -Fc abrit > backups/abrit-$(date +%F).dump
```

Restore (disaster drill — test this BEFORE you need it):

```bash
cat backups/abrit-2026-01-01.dump | docker compose -f docker-compose.prod.yml \
  --env-file .env.production exec -T db pg_restore -U abrit -d abrit --clean --if-exists
```

Retention policy: keep ≥ 14 daily dumps, and copy one off-host weekly (object
storage or another machine — a backup on the same disk is not a backup).

## 7. Restart behavior (what survives, what re-drives)

| State | On restart |
|---|---|
| `restart: unless-stopped` | all three services come back automatically after a crash **or a host reboot** |
| Database | persists in the `abrit_pgdata` volume |
| Ingested updates left `RECEIVED`/stuck | the 15 s sweeper re-drives them (pipeline is crash-safe by design, see docs/test-report.md) |
| Outbox rows with an expired delivery lease | re-claimed after the 60 s lease; sends are at-least-once |
| Per-chat in-memory processing queue | empty on boot — ordering is re-derived from the DB (the round-5 ordering gate) |
| Sessions (admin logins) | survive (signed JWT in an HttpOnly cookie; expiry = `JWT_EXPIRES_IN`) |
| Telegram polling/webhook | re-bootstrapped on start; a failed bootstrap aborts production boot (compose restarts it — see §9) |

## 8. Single instance (hard constraint)

The per-chat message ordering queue lives **in process memory**. Run exactly
ONE backend instance: the compose file pins `replicas: 1`. Do NOT put multiple
backend containers behind a load balancer — per-user message order could then
be violated. Scaling direction (out of scope for v1): move the queue to
PostgreSQL advisory locks or a broker; the outbox/inbox design is already
multi-instance-friendly.

## 9. Monitoring (liveness vs readiness)

| Probe | Endpoint | Fails when | Use for |
|---|---|---|---|
| Liveness | `GET /api/health/live` | never (process answers) | container restart policy — kills stuck processes only |
| Readiness | `GET /api/health/ready` | DB down, or **Telegram degraded** (token set but the transport failed to start) | LB/backend removal from rotation |

Readiness also REFLECTS integration status in the body
(`integrations.telegram`, `integrations.openRouter`: `disabled | starting | ok |
degraded`). A temporary OpenRouter outage degrades the AI answers (honest
fallback text) but never fails readiness — messages keep flowing. A dead bot
DOES fail readiness: the product is the bot, "API up + bot dead" must page
someone, not pass.

## 10. Upgrades & rollback

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Rollback: `git checkout <previous-tag>` then the same command. Because
migrations are forward-only, a rollback after a schema change needs
`npm run migration:revert` (run it deliberately, with a fresh backup taken
first — see §6).

## 11. Pre-flight checklist

- [ ] `.env.production` filled: `JWT_SECRET` (32+), `ADMIN_PASSWORD` (strong), `POSTGRES_PASSWORD`
- [ ] `CORS_ORIGIN` = the public HTTPS URL of the panel
- [ ] Telegram: `TELEGRAM_MODE=webhook`, URL = `https://<domain>/api/telegram/webhook`, secret set (or `polling` on a private host)
- [ ] `SEED_DEMO_DATA` NOT enabled (validation refuses it in production)
- [ ] HTTPS active (Option A or B) — cookies are `Secure` in production
- [ ] `--profile backup` enabled and `./backups` on the host
- [ ] One manual restore drill performed
- [ ] `/api/health/live` and `/api/health/ready` wired into your uptime monitor
- [ ] Exactly ONE backend instance running
