# Architecture

## The one rule this system optimizes for

**No message is ever lost** — every inbound update is persisted before
anything else (inbox `INSERT … ON CONFLICT DO NOTHING`) and every outbound
message is persisted as `PENDING` before any network attempt (transactional
outbox). **Nothing is processed twice** in normal operation: each step is
idempotent (PK/update_id dedup, atomic claims, partial unique indexes), so
retries and crashed attempts resume instead of duplicating work.

The precise delivery semantics are **at-least-once, single-send guaranteed**:

- concurrent duplicate *sends* are impossible (atomic claim with a 60 s lease,
  and every outcome write is fenced by a per-claim token — a sender whose lease
  expired mid-send writes 0 rows and aborts);
- the lease stays ALIVE while a send is in flight: every chunk's network call
  is preceded by a lease RENEWAL and bounded by `TELEGRAM_SEND_TIMEOUT_MS`
  (default 30 s < the 60 s lease), so a slow Telegram can no longer let a
  sender's lease expire mid-request — the sweeper can never re-claim a message
  that another worker is still sending (review round 5);
- storage and processing are idempotent — the same update can never produce
  two user messages or two assistant replies;
- the claim consumes the attempt counter at claim time, so a hard crash
  between a claim and any bookkeeping still burns one of the 5 retries;
- TRANSIENT failures (network errors, 5xx, unknown 4xx) schedule the next
  attempt with **exponential backoff + jitter** on `messages.next_attempt_at`
  (~20 s → ~40 s → ~80 s → ~160 s, capped at 10 min) — a 2-minute Telegram
  outage no longer burns the whole retry budget in the first minute of 15 s
  sweeps. Telegram's explicit 429 `retry_after` overrides the computed
  schedule; well-known permanent 400s (chat not found, message text empty,
  message too long) and 403s stop retrying immediately (review round 5);
- FAILED messages are never locked away: an operator can re-arm any of them
  from the panel (`POST /api/tickets/:id/messages/:messageId/retry` — attempts
  reset, backoff cleared, multi-chunk progress kept) and the delivery resumes
  immediately (review round 5);
- the ONE residual window is a hard crash — or a client-side timeout of a
  request that Telegram actually completes — between the external send of a
  chunk and its durable progress commit: that single chunk can be re-sent once
  on recovery (this window exists for EVERY chunk of a multipart send, not
  just the last; Telegram dedups nothing). Exactly-once delivery is
  impossible across an unacknowledged external API call — claiming otherwise
  would be dishonest.

Everything else (dashboard, panel niceties) is secondary to that guarantee.

## The path of a message (9 steps)

```
1  Telegram update          user sends a message to the bot
2  Ingest (webhook|polling) secret check → instant HTTP 200
3  bot_updates (inbox)      INSERT … ON CONFLICT DO NOTHING  ← point of no return
4  Processor                atomic claim (RECEIVED → PROCESSING)
5  Conversation             user upsert → active ticket → USER message (short tx)
6  Context builder          last N messages OF THE SAME ticket only
7  AI provider → OpenRouter timeout · retry ≤ 2 · fallback model
8  messages (outbox)        ASSISTANT reply stored PENDING     ← second point of no return
9  Telegram gateway         SENT or FAILED (+ sweeper retries)
```

After step 3 the user's message cannot be lost; after step 8 the reply cannot.
Whatever happens in between is retryable, idempotent — and **resumable**: each
completed milestone is recorded on `bot_updates.stage`
(`CLAIMED → USER_SAVED → REPLY_SAVED`), so a re-run after a crash CONTINUES
the half-finished work instead of dropping it.

## Components

| Component | Responsibility |
|---|---|
| `modules/telegram` | Telegraf transport (polling/webhook), gateway interface, webhook controller (constant-time secret), outbox dispatcher, sweeper |
| `modules/conversation` | Orchestrator (claim → upsert → command/ticket flow → reply) and bot commands; per-chat serial promise queue |
| `modules/ai` | `AiProvider` interface, `OpenRouterProvider` (fetch, no SDK), `ContextBuilder` (ticket isolation), retry/backoff policy, concurrency semaphore |
| `modules/inbox` | `bot_updates` ingest/claim/requeue + stage tracking + retention purge |
| `modules/{users,tickets,messages,settings}` | Domain services (business rules + outbox writes) |
| `modules/auth`, global guard | JWT everywhere except `@Public()` routes; login rate-limited |
| `modules/ws` | Socket.IO gateway (same JWT, room `admins`) bridged to domain events |
| `modules/dashboard` | One aggregate query (COUNT FILTER) + users count |

## Crash matrix

| Crash point | Result after restart |
|---|---|
| Before inbox insert | Telegram re-delivers (webhook) or offset not acked (polling) — nothing lost |
| Inbox stored, not processed | Sweeper re-drives RECEIVED rows |
| Mid-processing (row PROCESSING) | Sweeper requeues after 2 min, ≤ 3 attempts, then FAILED (last_error preserved). Later messages of the same chat wait at the ordering gate until the row is terminal |
| After ticket insert, before announcement | Impossible — both commit in ONE transaction (review fix) |
| After USER message stored, before reply | **RESUME**: the stored message pins the update to its ORIGINAL ticket (checked BEFORE creating a new one), `addUserMessage` returns the already-stored row, the AI reply step then runs — the user is never left unanswered and no empty active ticket is created. An already-stored reply short-circuits the AI call |
| After outbox claim, before any bookkeeping | The claim already consumed one of the 5 delivery attempts — crash loops are bounded |
| After a chunk's Telegram send, before progress commit | At-least-once window: that ONE chunk can be re-sent once on recovery; the next claim continues at the first UNSENT chunk |
| After outbox insert, before send | Sweeper delivers PENDING rows (5 claims, `retry_after` honored); a crashed sender's lease (`claimed_at`) expires after 60 s and the row is reclaimed — fenced by the claim token so the zombie cannot race the new owner |

Events (websocket broadcast + immediate dispatch) are fired **after the
transaction commits**, so the panel and the dispatcher never observe a change
that could still roll back. The durable outbox insert itself stays INSIDE the
transaction (transactional-outbox pattern).

## Concurrency controls

- **Per-chat ordering** — an in-process `Map<chat_id, Promise>` serializes each
  user's updates so the second message's AI context contains the first reply.
  **Holds even after a failure (review fix)**: every private-text update checks
  a DB-level ORDERING GATE (`bot_updates`) before claiming — while an earlier
  update of the same chat has not reached a terminal state (DONE/FAILED), the
  later one stays RECEIVED (no attempts consumed) and the sweeper re-drives it
  once the blocker is finished. The earlier message's reply can therefore
  never reach the user after the later one's.
  ⚠ **Single-instance only**: the queue lives in process memory — with two or
  more backend instances behind a load balancer, updates of the same chat may
  land on different instances and their relative processing order is NOT
  guaranteed. Multi-instance ordering needs the scale-up path below (per-chat
  advisory locks or a shared queue).
- **AI concurrency cap** — a counting semaphore (default 3) protects the
  OpenRouter rate limit.
- **One active ticket per user** — PostgreSQL partial unique index, race-free;
  the service maps any CLOSED → active transition violation to a controlled
  409 (never a leaking 500).
- **Atomic claim (inbox)** — `UPDATE … WHERE status='RECEIVED' RETURNING` so two
  workers can never process the same update.
- **Atomic claim (outbox)** — every send starts with
  `claimForDelivery`: `UPDATE messages SET claimed_at = now() WHERE …` with a
  60 s lease; the immediate dispatcher and the sweeper can never deliver the
  same message twice, even concurrently.
- **Multi-part sends are resumable, fenced** — after every successfully
  delivered chunk the progress is committed to `messages.meta.sent_chunks`;
  a retry (sweeper or crash recovery) continues at the first UNSENT chunk. All
  progress/SENT/FAILED writes are fenced by the claim token, so a zombie
  sender whose lease expired aborts instead of racing the new owner. Honest
  at-least-once: a hard crash between a chunk's Telegram send and its progress
  commit can duplicate that ONE chunk (see the residual window above).
- **Operator replies are idempotent end-to-end** — the panel generates a
  `client_message_id` per draft-send, BOUND TO THE EXACT CONTENT of that
  attempt: retrying an unchanged draft reuses the key (a lost HTTP response
  replays the ORIGINAL message — the user never receives the same reply
  twice), while an edited draft automatically becomes a NEW send with a
  fresh key. Reusing a key with different content is rejected with 409
  instead of answering with the old message. A partial unique index
  (`role = 'ADMIN'`) enforces the uniqueness at the storage layer. The status
  check and the insert share one transaction holding the ticket row's
  pessimistic_write lock (the SAME lock `changeStatus` takes), so a reply can
  never slip into a ticket that closed concurrently.
- **Ticket creation is atomic with its announcement** — a new ticket and its
  opening SYSTEM message are written in ONE transaction, so a crash can never
  leave a ticket without its announcement. And a retry of an already-stored
  user message is pinned to the ORIGINAL ticket (dedup-first) — a crash
  recovery after an operator closed that ticket can never leave a fresh,
  EMPTY active ticket behind.
- **Blocked-state recovery, race-safe** — `is_blocked` is set when Telegram
  answers 403, but ONLY when no incoming message newer than the delivery's
  claim exists (a single conditional UPDATE against `last_seen_at`, review
  round 5): a late 403 from an old in-flight send can never overwrite the
  newer reality of a user who already unblocked and messaged again. A stale
  flag self-heals: receiving a fresh, valid update proves the user unblocked
  the bot, so the flag is cleared and processing resumes (a still blocked
  reality re-flags on the very next outbound 403 — but only if no newer
  activity arrived in the meantime).

## Data retention

`bot_updates` keeps the RAW Telegram payloads (needed only for crash-recovery
replays). `InboxRetentionService` purges rows older than
`BOT_UPDATES_RETENTION_DAYS` (default 30, `0` = keep forever) daily at 04:00 and
once at boot. Conversation messages (the actual ticket history) are kept
indefinitely and are NOT affected by the purge.

## Scale-up path (documented, not built — deliberate simplicity)

| When | Change | Cost |
|---|---|---|
| Multiple API/worker instances | `FOR UPDATE SKIP LOCKED` claim + Postgres advisory locks per chat; run the worker as a separate process (same code) | low |
| Heavier AI load | Real queue (BullMQ/Redis) behind the same `enqueue` interface | medium |
| Large tables | Partition `bot_updates.payload` out after 30 days; monthly partitioning; indexes are already in place | low |
| Very long tickets | Rolling summary of old messages + precise token budget | medium |
| Multi-admin/roles | `admins` roles table, audit log | medium |
| Observability | pino structured logs keyed by ticket_number/update_id, request-id, metrics | low |

## Known limitations

- **Per-chat ordering is NOT guaranteed in multi-instance deployments** — the
  queue is in-memory (single instance). Run exactly one backend instance per
  database until the scale-up path (per-chat advisory locks / shared queue)
  is built; no ordering claim should be made for horizontally-scaled setups.
- Outbox delivery is at-least-once. Concurrent duplicate sends are impossible
  (atomic claim + claim-token fencing + per-chunk lease renewal + a request
  timeout strictly below the lease), but a hard crash — or a client-side
  timeout of a request Telegram actually completes — between the external
  send of ANY chunk and its durable progress commit can duplicate that one
  chunk on recovery — the window exists for every chunk of a multipart send,
  not just the last. Exactly-once across an unacknowledged external API call
  is impossible; that residual window is the documented price.
- Context windowing is message-count + character-budget, not exact token count.
- Panel session = HttpOnly cookie (`abrit_session`, SameSite=Strict, Secure in
  production, maxAge = JWT_EXPIRES_IN) + double-submit CSRF guard; NO token in
  JavaScript. Bearer stays supported for API clients/Swagger.
- Deployment is now self-contained (round 6): backend/frontend Dockerfiles,
  nginx reverse proxy (REST + WebSocket), `docker-compose.prod.yml`, DB TLS
  support and the backup/migration/restart runbook — docs/DEPLOYMENT.md.
- A message right after `/close` opens a NEW ticket (simple, PDF-compliant
  policy; a post-close grace window is the possible refinement).
- Real Telegram/OpenRouter credentials are not exercised in the automated
  suites (delivery is faked) — a real-bot smoke run remains an owner task.
