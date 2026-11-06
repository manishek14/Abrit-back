# Database Design

PostgreSQL 16, TypeORM with `synchronize: false` — the schema lives in
`backend/src/database/migrations` and is the single source of truth.
Six tables: `admins`, `telegram_users`, `tickets`, `messages`, `bot_updates`,
`assistant_settings`.

```
telegram_users 1 ──── N tickets 1 ──── N messages
bot_updates (inbox)                        assistant_settings (singleton row)
admins ── (updated_by) ──► assistant_settings
       ── (admin_id)   ──► messages (future admin replies)
```

## Tables

### telegram_users
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| telegram_id | bigint | `UNIQUE` — one row per Telegram user (upsert) |
| chat_id | bigint | stored SEPARATELY from telegram_id (owner's decision) — keeps future group support trivial |
| username / first_name / last_name / language_code | varchar | from the update payload |
| is_blocked | bool | set when Telegram answers 403 (bot blocked); blocked users are silently dropped |
| created_at / updated_at / last_seen_at | timestamptz | |

### tickets
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| ticket_number | varchar UQ | `DEFAULT 'TKT-' \|\| nextval('ticket_number_seq')` (sequence starts 10001 — no MAX()+1 races) |
| user_id | uuid FK → telegram_users | ON DELETE RESTRICT |
| status | enum ticket_status | OPEN / IN_PROGRESS / CLOSED |
| subject | varchar(120) | first 60 chars of the opening message |
| created_at / updated_at / last_message_at / closed_at | timestamptz | |

### messages — history AND outbox in one table
| column | type | notes |
|---|---|---|
| id | bigint identity PK | string in Node (Postgres bigint) |
| ticket_id | uuid FK → tickets | ON DELETE CASCADE |
| role | enum message_role | USER / ASSISTANT / ADMIN / SYSTEM |
| content | text | |
| telegram_update_id | bigint | `UNIQUE` — 2nd dedup wall (1st: inbox PK) |
| in_reply_to_id | bigint FK → messages | `UNIQUE WHERE role='ASSISTANT'` — at most one AI reply per user message, even after crash+retry |
| delivery_status | enum | PENDING / SENT / FAILED — only outbound roles |
| claimed_at | timestamptz | delivery lease — atomic claim prevents duplicate sends; a crashed sender's lease expires after 60 s |
| delivery_attempts / error | int / text | sweeper backoff + visible failure reason |
| telegram_message_id | bigint | echo from Telegram after a successful send |
| admin_id | uuid FK → admins | the operator whose reply this is |
| client_message_id | varchar(64) | `UNIQUE WHERE role='ADMIN'` — panel's idempotency key; a retried send replays the original message instead of duplicating |
| meta | jsonb | model, latency, attempts, `sent_chunks`/`first_telegram_message_id` (multipart send progress)… — never secrets |
| created_at / sent_at | timestamptz | |

### bot_updates — the inbox
`update_id` bigint **PK** (dedup = one INSERT), payload jsonb (raw update),
status RECEIVED/PROCESSING/DONE/FAILED, attempts, last_error, received_at,
locked_at, processed_at, plus `stage` (varchar) — the last completed
processing milestone (`CLAIMED` / `USER_SAVED` / `REPLY_SAVED`) used for
resumable crash recovery and operator visibility. Rows are purged after
`BOT_UPDATES_RETENTION_DAYS` (default 30) by the retention service; the raw
payload is only needed for crash replays, never for history.

### assistant_settings — singleton
`id smallint CHECK (id = 1)`, system_prompt, model, is_active,
updated_by_admin_id, updated_at. Read on EVERY AI request (no cache) so panel
changes apply instantly.

## Critical constraints (all in the migration)

```sql
CREATE SEQUENCE ticket_number_seq START 10001;
ALTER TABLE tickets ALTER COLUMN ticket_number
  SET DEFAULT 'TKT-' || nextval('ticket_number_seq');

-- one ACTIVE ticket per user, even for two concurrent /new requests:
CREATE UNIQUE INDEX uq_active_ticket_per_user
  ON tickets (user_id) WHERE status <> 'CLOSED';

-- at most one assistant reply per user message (crash-safe):
CREATE UNIQUE INDEX uq_messages_in_reply_to_assistant
  ON messages (in_reply_to_id) WHERE role = 'ASSISTANT';

-- one operator reply per panel send (idempotent retries):
CREATE UNIQUE INDEX uq_messages_client_message_id
  ON messages (client_message_id) WHERE role = 'ADMIN';

-- fast sweeper scan:
CREATE INDEX idx_messages_delivery_pending
  ON messages (delivery_status)
  WHERE delivery_status IN ('PENDING', 'FAILED');

-- context & conversation page cost is independent of table size:
CREATE INDEX idx_messages_ticket_id_id ON messages (ticket_id, id);
```

## Why partial indexes matter here

The "one active ticket per user" rule is enforced by the DATABASE, not by
application code: two concurrent requests both try to INSERT, the loser gets
`23505`, and `ensureActiveTicket` simply re-reads the winner's row. This one
index removes an entire class of race conditions and also implements the
"closed ticket ⇒ next message opens a new ticket" policy for free.

## Rebuild from scratch

```bash
docker compose up -d db
cd backend && npm install && npm run start:dev   # migrationsRun + idempotent seeds
# or explicitly:
npm run migration:run
```
