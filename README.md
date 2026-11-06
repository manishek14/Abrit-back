# AbrIT Backend — Telegram Ticketing API & Bot

The NestJS backend of **AbrIT**, an AI-powered Telegram support-ticketing
system: the Telegram bot (Telegraf), the REST API for the admin panel, the
Socket.IO realtime gateway, PostgreSQL 16 persistence and the OpenRouter AI
integration.

> **Repository split:** this backend was extracted from the
> [AbrIT monorepo](https://github.com/manishek14/Abrit). The React admin
> panel lives in **[Abrit-front](https://github.com/manishek14/Abrit-front)**
> and expects this API on `http://localhost:3000`.

> **Stack:** NestJS 11 · TypeORM · PostgreSQL 16 · Telegraf · OpenRouter ·
> JWT + bcrypt · Jest + Supertest

## Features

- **Telegram bot** — real Telegram Bot API integration (Telegraf): `/start`,
  `/new`, `/mytickets`, `/profile`, `/status`, `/close`, `/cancel`, `/chatbot`,
  `/help`, dynamic reply keyboards, non-text and over-length notices. Polling by
  default, webhook mode via env.
- **Mandatory user profile** — a new user must complete a two-step registration
  (نام و نام خانوادگی → شماره همراه؛ the phone step offers a `request_contact`
  button and verifies the contact OWNER) before any main feature unlocks. The
  profile is persisted, so returning users are never asked twice.
- **Staged ticket wizard** — ثبت تیکت follows a strict flow: عنوان → دپارتمان
  (custom reply keyboard; free text can NEVER pick a department) → متن → atomic
  finalization (ticket + first message + SYSTEM announcement in ONE
  transaction) → a Persian confirmation with the REAL Jalali timestamp
  (Asia/Tehran, 24h, Persian digits). Cancel works at every step; a DB failure
  keeps the wizard state so nothing the user typed is lost.
- **/mytickets** — the user's OWN tickets only, with inline pagination and
  per-ticket detail view (`myt:view` / `myt:page` callbacks); cross-user access
  is structurally impossible (a foreign id reads as "not found"). Follow-up
  messages go INTO the selected ticket via 💬 ارسال پیام.
- **Profile gate** — protected features (ticket wizard, /mytickets, /chatbot,
  tracking) answer the restriction message plus a «تکمیل پروفایل»-ONLY reply
  keyboard; the gate is enforced in the router and every command handler, so no
  command spelling or plain text can bypass it. `/profile` itself is NEVER
  gated: complete → the card (name + phone only); incomplete → the completion
  flow starts directly, no restriction message. The card carries a
  «✏️ ویرایش اطلاعات» entry that re-runs registration.
- **/chatbot mode** — the ONLY AI entry: `/chatbot` enters a dedicated chat
  mode (intro + exit-button keyboard, CHAT state). Every plain text in the mode
  goes to OpenRouter — even menu-button labels — and never becomes a ticket or
  menu action; real commands and «🔙 بازگشت به منوی اصلی» still work. Each
  question first shows "Chatbot is working on your request. Please wait a
  moment." which is then edited IN PLACE into the answer (`editMessageText`,
  fresh sends as the fallback, 4096-char split); provider failures read as an
  understandable, retryable error. One update can never call OpenRouter twice
  (durable `last_update_id` marker). `/help` lists the commands and NEVER
  touches OpenRouter — the BotFather command list is synced at boot with the
  same wording.
- **ABRIT AI general chat** — out-of-ticket plain text goes to OpenRouter with
  the fixed ABRIT AI persona (Persian-first, no invented ticket data, guides
  users to the menus). An OpenRouter outage only degrades the chat —
  registration, the wizard and /mytickets keep working. The state machine lives
  on `telegram_users.bot_state` (DB-backed, 3h TTL, strict routing: a wizard
  step's text is consumed by the wizard and NEVER reaches the AI handler).
- **No lost messages, resumable processing** — every update is persisted to an
  inbox table first (`INSERT … ON CONFLICT DO NOTHING`), the caller gets an
  instant `200`, and processing happens asynchronously with atomic claims,
  per-chat ordering (held after failures by a DB-level gate) and a 15-second
  sweeper. Processing milestones are tracked per update
  (`CLAIMED → USER_SAVED → REPLY_SAVED`), so a crash mid-flight **resumes**
  instead of dropping the half-finished work. A user flagged blocked after a
  Telegram 403 is auto-recovered the moment they message the bot again.
- **Independent ticket memory** — the AI context is built ONLY from the same
  `ticket_id` (query-level guarantee, not a prompt instruction), with role
  mapping, merging and a character budget. One active ticket per user is
  enforced by a PostgreSQL partial unique index.
- **Durable outbox, single delivery** — every outbound message (AI reply, admin
  notification) is stored `PENDING` before any network attempt; each send is
  guarded by an **atomic claim with a 60 s lease**, so the immediate dispatcher
  and the sweeper can never deliver the same message twice. Retries respect
  `retry_after`, and permanent failures (user blocked the bot) stop retrying.
- **AI with error policy** — OpenRouter behind an interface with timeout,
  retry/backoff, error classification (401/402/404 → no retry, 429/5xx →
  retry) and an honest fallback message; the assistant is configurable from the
  panel (prompt, model, on/off) and applies instantly.
- **Admin panel API** — login, dashboard stats, ticket filters/search/
  pagination (owner name embedded), ticket conversation (bidi-safe Persian
  content), operator replies from the composer (stored as ADMIN outbox rows
  with `admin_id`, delivered by the same durable dispatcher), users, assistant
  settings — all realtime via **Socket.IO** with automatic polling fallback.
  (The panel itself is [Abrit-front](https://github.com/manishek14/Abrit-front).)
- **Secure by default** — JWT everywhere except login/health/webhook (webhook
  authenticates with the dedicated Telegram secret, compared in constant time
  and with structural payload validation), bcrypt-hashed passwords, login rate
  limiting, CORS restricted to the panel, helmet, strict DTO validation,
  secrets only via env — and **production mode refuses to boot** with known/
  example JWT secrets, a default admin password or demo seeding enabled.

## Architecture in one paragraph

A single NestJS app serves the REST API (`/api`), the Socket.IO gateway and the
Telegram integration. Incoming updates flow: webhook/polling → `bot_updates`
inbox (point of no return) → atomic claim → per-chat serial queue → user upsert
→ command or ticket flow → `messages` (history + outbox) → OpenRouter (when a
key is configured) → outbox delivery → Telegram. The sweeper (every 15 s)
re-drives stale inbox rows and re-delivers due outbox messages. Domain events
power both the outbox dispatcher and the panel's websocket updates. See
[docs/architecture.md](docs/architecture.md),
[docs/database-design.md](docs/database-design.md) and
[docs/test-report.md](docs/test-report.md).

## Prerequisites

- Node.js ≥ 20.19
- Docker (for PostgreSQL) **or** a local PostgreSQL 16
- A Telegram bot token and an OpenRouter API key (see below — this repository
  intentionally ships with both **empty**; everything else works without them)

## Quick start (development)

```bash
cp .env.example .env          # set JWT_SECRET; Telegram/OpenRouter keys stay empty for now
docker compose up -d db       # PostgreSQL 16 on :5432 (db-test for e2e on :5433)

npm install
npm run start:dev             # migrations run automatically on boot (idempotent)
# API:      http://localhost:3000/api
# Swagger:  http://localhost:3000/api/docs
# Login:    admin@abrit.local / Admin1234! (from .env.example — change in .env)
```

The admin panel is a separate repository and expects this API on `:3000`:

```bash
git clone https://github.com/manishek14/Abrit-front.git
cd Abrit-front && npm install && npm run dev   # panel on http://localhost:5173
```

Demo data (Persian sample users/tickets/messages) is seeded automatically on
first boot (`SEED_DEMO_DATA=true`).

## راه‌اندازی سریع (فارسی)

```bash
cp .env.example .env          # مقدار JWT_SECRET را عوض کنید
docker compose up -d db       # پایگاه‌داده PostgreSQL روی پورت 5432

npm install && npm run start:dev   # مایگریشن‌ها هنگام بوت اجرا می‌شوند
```

- پنل مدیریت در ریپازیتوری جداگانه
  [Abrit-front](https://github.com/manishek14/Abrit-front) است و به همین API
  وصل می‌شود.
- ورود پیش‌فرض: `admin@abrit.local` / `Admin1234!` (از `.env.example`؛ در
  تولید عوضش کنید)
- **توکن ربات تلگرام و کلید OpenRouter فعلاً خالی است**. تا وقتی خالی باشند
  این دو سرویس غیرفعال می‌مانند و فقط یک پیام اطلاع‌رسانی در لاگ ثبت می‌شود؛
  بقیه سیستم (API، پایگاه‌داده، تست‌ها) کامل کار می‌کند. با ست‌کردن
  `TELEGRAM_BOT_TOKEN` ربات و با ست‌کردن `OPENROUTER_API_KEY` دستیار هوشمند
  فعال می‌شود — بدون هیچ تغییری در کد.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables strict boot rules (see below) |
| `PORT` | `3000` | API port |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed panel origin(s), comma-separated |
| `APP_TIMEZONE` | `Asia/Tehran` | Timezone for dashboard "today" stats |
| `DATABASE_URL` | — (required) | e.g. `postgres://abrit:abrit@127.0.0.1:5432/abrit` |
| `DATABASE_SSL` / `DATABASE_SSL_CA` | `false` / *(empty)* | TLS for managed PostgreSQL (`true` = encrypt; `CA` (PEM) additionally pins the server cert); `?sslmode=require` in the URL also works |
| `MIGRATIONS_RUN` | `true` | Run pending migrations on boot |
| `SEED_DEMO_DATA` | `true` (dev) / `false` (prod) | Seed Persian demo data when the DB is empty — **refused in production** |
| `BOT_UPDATES_RETENTION_DAYS` | `30` | Purge raw Telegram inbox payloads older than N days (`0` = keep forever); conversation history is never purged |
| `JWT_SECRET` | — (**required**) | ≥ 16 trimmed chars (whitespace-only and repeated patterns rejected everywhere); ≥ 32 trimmed chars in production |
| `JWT_EXPIRES_IN` | `8h` | Admin session lifetime — the JWT and the session cookie maxAge share this ONE policy (`45m` / `8h` / `7d`) |
| `COOKIE_SECURE` | `true` in production | The panel session cookie is HttpOnly + SameSite=Strict; `Secure` defaults on in production (HTTPS mandatory) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@abrit.local` / `Admin1234!` (dev only) | First admin (seeded idempotently, bcrypt-hashed); **must be set explicitly in production and strong: 12+ trimmed chars, ≥ 3 character classes** |
| `TELEGRAM_MODE` | `polling` | `polling` or `webhook` |
| `TELEGRAM_BOT_TOKEN` | *(empty)* | Bot disabled while empty; real token verified in the 2026-11-06 smoke test (@ABRIT_Ticket_Bot) |
| `TELEGRAM_WEBHOOK_URL` / `TELEGRAM_WEBHOOK_SECRET` | *(empty)* | Webhook mode only (secret required in that mode) |
| `TELEGRAM_ALLOWED_UPDATES` | `message,callback_query` | Comma-separated update types; `callback_query` is required for the /mytickets inline pagination buttons |
| `OPENROUTER_API_KEY` | *(empty)* | Fixed fallback reply while empty |
| `OPENROUTER_DEFAULT_MODEL` | `nvidia/nemotron-3-ultra-550b-a55b:free` | Seeded default model — verified with the owner's key (openrouter/auto is region-blocked for it: 403) |
| `OPENROUTER_TIMEOUT_MS` | `25000` | Per-request abort timeout |
| `AI_CONTEXT_MAX_MESSAGES` | `20` | Context window (messages) |
| `AI_MAX_CONCURRENCY` | `3` | Global AI concurrency cap |
| `AI_MAX_OUTPUT_TOKENS` | `500` | Response token cap |
| `AI_CONTEXT_MAX_CHARS` | `21000` | Context character budget |

## Creating the bot & getting an OpenRouter key

1. **Telegram bot**: talk to [@BotFather](https://t.me/BotFather) → `/newbot`
   → copy the token into `TELEGRAM_BOT_TOKEN` → restart. Then in the bot chat:
   `/start` (completes the mandatory profile), then «🎫 ثبت تیکت جدید» and
   follow the wizard (title → department → description), check «📋 تیکت‌های من»
   or `/mytickets`, ask general questions in plain text (ABRIT AI), `/status`,
   `/close`. Optionally run
   `curl -F "url=https://YOUR HOST/api/telegram/webhook" -F "secret_token=$TELEGRAM_WEBHOOK_SECRET" https://api.telegram.org/bot<TOKEN>/setWebhook`
   and switch `TELEGRAM_MODE=webhook`.
2. **OpenRouter**: create a key at <https://openrouter.ai/keys> → put it in
   `OPENROUTER_API_KEY` → restart. Pick a model in the panel
   (Abrit-front → Settings → Assistant — the live OpenRouter model list) or
   keep the verified default.

## Running the tests

```bash
npm test                # 406 unit tests (no DB, no network)
npm run test:e2e        # 67 e2e scenarios on REAL PostgreSQL (db abrit_test, or E2E_DATABASE_URL)
npm run test:cov        # coverage
```

The e2e suite boots the whole application with only the Telegram transport
faked — dedup, concurrency, ticket isolation, status rules, auth, sweeper
crash-recovery, crash **resume**, outbox concurrency/lease, newest-first
pagination + load-older, **operator replies (delivery + realtime badges)**,
**idempotent operator replies (client_message_id replay)**, **multi-part send
resume (per-chunk progress)**, cursor range validation, input validation,
retention and the websocket channel all run against a real database. The
frontend component tests live in
[AbrIT-front](https://github.com/manishek14/Abrit-front). See
[docs/test-report.md](docs/test-report.md).

**CI:** every push runs the backend build + unit tests and the e2e suite on a
real PostgreSQL 16 service — [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Production checklist

1. `NODE_ENV=production` — the app then refuses to boot unless:
   - `JWT_SECRET` is at least 32 characters after trimming, not blank,
     not a repeated pattern and not a known/example value
     (`openssl rand -hex 32`),
   - `ADMIN_PASSWORD` is set explicitly and strong (12+ trimmed characters,
     at least 3 of lowercase/UPPERCASE/digits/symbols; the dev default is
     rejected),
   - `SEED_DEMO_DATA=false`.
2. Set a strong `CORS_ORIGIN` (the panel's real origin).
3. Decide the retention window (`BOT_UPDATES_RETENTION_DAYS`, default 30).
4. Fill `TELEGRAM_BOT_TOKEN` / `OPENROUTER_API_KEY` when you go live — no code
   changes needed. A failed Telegram bootstrap **aborts a production boot**
   (in development it degrades readiness instead).

## Production deployment

The backend Dockerfile, an nginx reverse proxy (REST + WebSocket:
`deploy/nginx-tls.conf`), the production compose file
(`docker-compose.prod.yml` — builds THIS repository; the `frontend` service
consumes the `abrit-front:latest` image built from
[AbrIT-front](https://github.com/manishek14/Abrit-front)), managed-PostgreSQL
TLS support and the full runbook — backup/retention, HTTPS, restart behavior,
the single-instance constraint and the liveness/readiness monitoring split —
live in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** with
`.env.production.example`.

License: UNLICENSED (private trial project).

## Sync provenance

- **Sync base:** `manishek14/Abrit@4dde1ca` — monorepo `main` HEAD at
  extraction time (2026-11-06). Every commit below the extraction commit maps
  1:1 to a monorepo commit that touched `backend/`; root-level deployment
  assets (`docs/`, `docker-compose*.yml`, `deploy/`, `ai-usage.txt`) were
  copied from the monorepo root.
- Application code is byte-identical to the monorepo subtree (verified by git
  tree-hash comparison).
- To sync future monorepo changes: cherry-pick monorepo commits touching
  `backend/`, or re-run `git filter-branch --subdirectory-filter backend` on
  the monorepo and merge.
