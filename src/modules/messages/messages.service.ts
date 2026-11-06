import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Message } from '../../database/entities/message.entity';
import { Ticket } from '../../database/entities/ticket.entity';
import { DeliveryStatus, MessageRole, TicketStatus } from '../../database/enums';
import { EventsService } from '../../common/events/events.service';
import { isUniqueViolation } from '../../common/utils/pg-errors';
import { firstRawRow } from '../../common/utils/raw-rows';

export interface AddAdminMessageResult {
  message: Message;
  /** true = the client_message_id already existed: the ORIGINAL message is
   *  returned unchanged (idempotent replay), nothing new was stored. */
  replayed: boolean;
}

/** Send attempts per outbound message (immediate + sweeper retries, backoff respected). */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Delivery lease: a claimed message cannot be re-claimed for this long (review fix #2). */
export const DELIVERY_LEASE_MS = 60_000;

/**
 * Retry backoff (review round 5 fix): after the Nth transient failure the next
 * attempt waits `base * 2^(N-1)` (± 20% jitter), capped at MAX. With the 5
 * attempts this yields a schedule of ~20 s → ~40 s → ~80 s → ~160 s, so the
 * last retry lands ~5 minutes after the first — a 2-minute Telegram outage no
 * longer burns the whole retry budget within the first minute of 15 s sweeps.
 */
export const OUTBOX_RETRY_BASE_MS = 20_000;
export const OUTBOX_RETRY_MAX_MS = 10 * 60_000;

/**
 * Exponential backoff + jitter for the NEXT delivery attempt.
 * @param failedAttempt 1-based number of the attempt that JUST failed
 *   (delivery_attempts as counted at claim time).
 * @param rand injectable for tests — the jitter source in [0, 1).
 */
export function computeRetryBackoffMs(
  failedAttempt: number,
  rand: number = Math.random(),
): number {
  const exponential =
    OUTBOX_RETRY_BASE_MS * 2 ** Math.min(Math.max(failedAttempt - 1, 0), 10);
  const capped = Math.min(exponential, OUTBOX_RETRY_MAX_MS);
  const jitter = 1 + (rand * 2 - 1) * 0.2; // ± 20%
  return Math.max(1_000, Math.round(capped * jitter));
}

/** Initial conversation page size (review fix: agents land on the NEWEST slice). */
export const INITIAL_PAGE_SIZE = 50;

/** Hard cap for any conversation page (controller DTO mirrors this). */
export const MAX_PAGE_SIZE = 1000;

export interface AddUserMessageInput {
  ticket_id: string;
  content: string;
  /** Telegram update_id — the second dedup wall; one user message per update, ever. */
  telegram_update_id?: string | null;
}

export interface AddOutboundMessageInput {
  ticket_id: string;
  role: MessageRole.ASSISTANT | MessageRole.ADMIN | MessageRole.SYSTEM;
  content: string;
  in_reply_to_id?: string | null;
  admin_id?: string | null;
  meta?: Record<string, unknown> | null;
}

@Injectable()
export class MessagesService {
  constructor(
    @InjectRepository(Message) private readonly repo: Repository<Message>,
    private readonly events: EventsService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * THE MESSAGE-CREATION CONTRACT — every path that stores a message follows
   * exactly one shape (review fix #6):
   *   1. the message row AND ticket.last_message_at commit in ONE transaction;
   *   2. the `message.created` event fires only AFTER that commit, so the
   *      outbox dispatcher and the panel never see data that could still roll
   *      back (they would otherwise deliver a phantom message);
   *   3. every creation route is idempotent (unique dedup + resume), so the
   *      sweeper can always finish half-done work.
   *
   * With `requireOpenTicket` the transaction FIRST locks the ticket row with
   * the SAME pessimistic_write lock `TicketsService.changeStatus` takes, then
   * checks the status and inserts — so a concurrent close can never slip
   * between the check and the store (review fix: closed-ticket race).
   */
  private async persistWithTouch(
    create: (manager: EntityManager) => Promise<Message>,
    ticketId: string,
    opts: { requireOpenTicket?: boolean } = {},
  ): Promise<Message> {
    const saved = await this.dataSource.transaction(async (manager) => {
      if (opts.requireOpenTicket) {
        const ticket = await manager.findOne(Ticket, {
          where: { id: ticketId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!ticket) throw new NotFoundException('Ticket not found');
        if (ticket.status === TicketStatus.CLOSED) {
          throw new ConflictException('Ticket is closed — reopen it to reply');
        }
      }
      const message = await create(manager);
      await manager.update(Ticket, ticketId, { last_message_at: new Date() });
      return message;
    });
    this.events.emit('message.created', { message: saved });
    return saved;
  }

  /**
   * Stores a user message and touches ticket.last_message_at.
   *
   * RESUME semantics (review fix #1): a unique violation on telegram_update_id
   * can only mean a PREVIOUS attempt stored this message and crashed before
   * finishing (ingest dedups update_id; claim dedups concurrent workers). So
   * instead of failing we return the existing row and let the caller continue
   * with the reply step — half-finished work is resumed, never dropped.
   *
   * The resumed message also gets its ticket touch and its `message.created`
   * event (review fix #5): the previous attempt may have died before the event
   * went out, so a panel watching the ticket could have missed the message.
   * Both are idempotent — the panel merges by message id, the touch just bumps
   * a timestamp — so re-firing them can never cause a duplicate.
   */
  async addUserMessage(input: AddUserMessageInput): Promise<Message> {
    try {
      return await this.persistWithTouch(
        (manager) =>
          manager.save(
            Message,
            manager.create(Message, {
              ticket_id: input.ticket_id,
              role: MessageRole.USER,
              content: input.content,
              telegram_update_id: input.telegram_update_id ?? null,
            }),
          ),
        input.ticket_id,
      );
    } catch (e) {
      if (isUniqueViolation(e) && input.telegram_update_id) {
        const existing = await this.repo.findOne({
          where: { telegram_update_id: input.telegram_update_id },
        });
        if (existing) {
          await this.touchTicket(input.ticket_id);
          this.events.emit('message.created', { message: existing });
          return existing;
        }
      }
      if (isUniqueViolation(e)) {
        throw new ConflictException('Duplicate user message for this telegram update');
      }
      throw e;
    }
  }

  /** The assistant reply to a given user message, if one was already stored. */
  async findAssistantReply(userMessageId: string): Promise<Message | null> {
    return this.repo.findOne({
      where: { in_reply_to_id: userMessageId, role: MessageRole.ASSISTANT },
    });
  }

  /** The user message a previous attempt stored for this Telegram update, if any. */
  async findByTelegramUpdateId(telegram_update_id: string): Promise<Message | null> {
    return this.repo.findOneBy({ telegram_update_id });
  }

  /**
   * Outbox insert — every outbound message (AI, admin, system notification) is
   * persisted as PENDING BEFORE any network attempt, so a crash can never lose it.
   * Unique violation on in_reply_to_id = the ASSISTANT already replied to this
   * user message (retry after crash) → ConflictException.
   */
  async addOutboundMessage(input: AddOutboundMessageInput): Promise<Message> {
    try {
      return await this.persistWithTouch(
        (manager) =>
          manager.save(
            Message,
            manager.create(Message, {
              ticket_id: input.ticket_id,
              role: input.role,
              content: input.content,
              in_reply_to_id: input.in_reply_to_id ?? null,
              admin_id: input.admin_id ?? null,
              meta: input.meta ?? null,
              delivery_status: DeliveryStatus.PENDING,
            }),
          ),
        input.ticket_id,
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('An assistant reply for this message already exists');
      }
      throw e;
    }
  }

  /**
   * Operator reply from the panel (review fix #4). Stored as a PENDING outbox
   * row with admin_id recorded; the dispatcher delivers it to Telegram exactly
   * like assistant replies and `message.updated` events flip the panel's
   * delivery badge to SENT/FAILED in realtime.
   *
   * Race-safe (review fix): the open-ticket check and the insert share ONE
   * transaction holding the ticket row lock — a concurrent `changeStatus` to
   * CLOSED blocks on the same lock, so no reply can ever land in a closed
   * ticket, and no close can interleave between check and store.
   *
   * IDEMPOTENT (review fix): when `client_message_id` is supplied, a replay
   * (the operator retried because the first HTTP response was lost) returns
   * the original row — the panel-generated key is protected by a partial
   * unique index, so a duplicate reply can never reach the user twice.
   *
   * The key is BOUND TO THE CONTENT it was created for (review fix): a replay
   * is only honored when the content is IDENTICAL — the same key with a
   * DIFFERENT body is a client bug (or a stale tab) and is answered with a
   * 409 instead of silently returning the old message, which would make the
   * panel wipe an edited draft that was never sent. The panel-side contract:
   * retrying an unchanged draft reuses the key; editing the draft is a NEW
   * send with a fresh key.
   *
   * The replay also re-fires `message.created`: if the first attempt died
   * right after commit, this heals both the panel merge and the immediate
   * delivery (the atomic claim keeps a double Telegram send impossible).
   */
  async addAdminMessage(input: {
    ticket_id: string;
    content: string;
    admin_id: string;
    client_message_id?: string | null;
  }): Promise<AddAdminMessageResult> {
    // Fast replay path — checked BEFORE the transaction so a retry is answered
    // even if the ticket was closed after the original send (the reply is
    // already stored and being delivered; the operator should see that).
    if (input.client_message_id) {
      const existing = await this.findAdminByClientId(input.client_message_id);
      if (existing) {
        if (existing.content !== input.content) {
          throw new ConflictException(
            'client_message_id was already used for a different message — send the edited draft as a new message (the panel does this automatically)',
          );
        }
        this.events.emit('message.created', { message: existing });
        return { message: existing, replayed: true };
      }
    }

    try {
      const message = await this.persistWithTouch(
        (manager) =>
          manager.save(
            Message,
            manager.create(Message, {
              ticket_id: input.ticket_id,
              role: MessageRole.ADMIN,
              content: input.content,
              admin_id: input.admin_id,
              client_message_id: input.client_message_id ?? null,
              delivery_status: DeliveryStatus.PENDING,
            }),
          ),
        input.ticket_id,
        { requireOpenTicket: true },
      );
      return { message, replayed: false };
    } catch (e) {
      // Lost the concurrent replay race: the other request with the same
      // client_message_id committed first → return THEIR message (identical
      // content only — a different body is a 409, same as the fast path).
      if (isUniqueViolation(e) && input.client_message_id) {
        const existing = await this.findAdminByClientId(input.client_message_id);
        if (existing) {
          if (existing.content !== input.content) {
            throw new ConflictException(
              'client_message_id was already used for a different message — send the edited draft as a new message (the panel does this automatically)',
            );
          }
          this.events.emit('message.created', { message: existing });
          return { message: existing, replayed: true };
        }
      }
      throw e;
    }
  }

  private async findAdminByClientId(clientMessageId: string): Promise<Message | null> {
    return this.repo.findOne({
      where: { client_message_id: clientMessageId, role: MessageRole.ADMIN },
    });
  }

  /**
   * Conversation history in chronological order (review fix: the agent lands on
   * the conversation's LATEST messages, older history is paged in on demand).
   *   no cursor   — the LAST `limit` messages (initial page); has_more = older
   *                 messages exist above the page (→ the "load older" button).
   *   after=<id>  — incremental refresh: messages NEWER than the cursor,
   *                 ascending; has_more = newer messages exist beyond the page.
   *   before=<id> — backward pagination: the `limit` messages immediately OLDER
   *                 than the cursor, ascending; has_more = older ones remain.
   */
  async getConversationPage(
    ticket_id: string,
    options: { after?: string; before?: string; limit?: number } = {},
  ): Promise<{ messages: Message[]; has_more: boolean }> {
    const limit = Math.min(options.limit ?? INITIAL_PAGE_SIZE, MAX_PAGE_SIZE);

    if (options.before) {
      const rows = await this.repo
        .createQueryBuilder('m')
        .where('m.ticket_id = :ticket_id', { ticket_id })
        .andWhere('m.id < :before', { before: options.before })
        .orderBy('m.id', 'DESC')
        .take(limit + 1)
        .getMany();
      const has_more = rows.length > limit;
      return { messages: rows.slice(0, limit).reverse(), has_more };
    }

    if (options.after) {
      const rows = await this.repo
        .createQueryBuilder('m')
        .where('m.ticket_id = :ticket_id', { ticket_id })
        .andWhere('m.id > :after', { after: options.after })
        .orderBy('m.id', 'ASC')
        .take(limit + 1)
        .getMany();
      const has_more = rows.length > limit;
      return { messages: rows.slice(0, limit), has_more };
    }

    // Initial page: the NEWEST `limit` messages, returned ascending.
    const rows = await this.repo
      .createQueryBuilder('m')
      .where('m.ticket_id = :ticket_id', { ticket_id })
      .orderBy('m.id', 'DESC')
      .take(limit + 1)
      .getMany();
    const has_more = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse(), has_more };
  }

  /** The LAST `limit` messages in chronological order — the AI context source for a ticket. */
  async getRecentConversation(ticket_id: string, limit: number): Promise<Message[]> {
    const rows = await this.repo
      .createQueryBuilder('m')
      .where('m.ticket_id = :ticket_id', { ticket_id })
      .orderBy('m.id', 'DESC')
      .take(limit)
      .getMany();
    return rows.reverse();
  }

  async findById(id: string): Promise<Message | null> {
    return this.repo.findOneBy({ id });
  }

  /** Outbox scan for the sweeper: PENDING + retryable FAILED, capped attempts,
   *  retry_after deferrals AND the backoff schedule (next_attempt_at) respected,
   *  optionally skipping fresh rows that the immediate dispatcher may still be
   *  sending (review round 5: a transient failure no longer retries on the
   *  very next 15 s sweep — it waits for its scheduled slot). */
  async findDueOutbox(
    limit = 20,
    opts: { freshWindowMs?: number } = {},
  ): Promise<Message[]> {
    const qb = this.repo
      .createQueryBuilder('m')
      .where('m.delivery_status IN (:...statuses)', {
        statuses: [DeliveryStatus.PENDING, DeliveryStatus.FAILED],
      })
      .andWhere('m.delivery_attempts < :max', { max: MAX_DELIVERY_ATTEMPTS })
      .andWhere(
        `NOT (m.meta ->> 'retry_after_until' IS NOT NULL AND (m.meta ->> 'retry_after_until')::timestamptz > now())`,
      )
      .andWhere('(m.next_attempt_at IS NULL OR m.next_attempt_at <= now())')
      .orderBy('m.id', 'ASC')
      .take(limit);

    if (opts.freshWindowMs) {
      qb.andWhere('m.created_at < :cutoff', { cutoff: new Date(Date.now() - opts.freshWindowMs) });
    }
    return qb.getMany();
  }

  /**
   * Atomic delivery claim (review fix #2): exactly one UPDATE wins, so the
   * immediate dispatcher and the sweeper can never send the same message
   * concurrently. A stale lease (crashed sender) simply expires and is
   * reclaimable. Returns null when someone else owns the send or the message
   * is terminal — callers MUST skip in that case.
   *
   * CRASH-SAFE ATTEMPT COUNTING (review fix): the attempt counter is consumed
   * HERE, at claim time — a sender that dies hard (process crash between claim
   * and any bookkeeping) has still spent one of its MAX_DELIVERY_ATTEMPTS
   * claims, so a crash loop can never deliver forever.
   *
   * CLAIM TOKEN / FENCING (review fix): every claim also stamps a fresh token
   * into meta. All later writes for THIS delivery (chunk progress, SENT,
   * FAILED, deferral) are fenced by the token, so a zombie sender whose lease
   * expired (e.g. a multi-chunk send that outlived 60 s) cannot fight the new
   * owner: its writes match 0 rows and it aborts as soon as it notices.
   */
  async claimForDelivery(
    messageId: string,
    leaseMs: number = DELIVERY_LEASE_MS,
  ): Promise<Message | null> {
    const claimToken = randomUUID();
    const rows = await this.repo.query(
      `UPDATE messages
          SET claimed_at = now(),
              delivery_attempts = delivery_attempts + 1,
              meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('claim_token', $4::text)
        WHERE id = $1
          AND delivery_status IN ('PENDING', 'FAILED')
          AND delivery_attempts < $2
          AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $3))
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          AND NOT (
            meta ->> 'retry_after_until' IS NOT NULL
            AND (meta ->> 'retry_after_until')::timestamptz > now()
          )
        RETURNING *`,
      [messageId, MAX_DELIVERY_ATTEMPTS, Math.max(1, Math.round(leaseMs / 1000)), claimToken],
    );
    return firstRawRow<Message>(rows);
  }

  /**
   * LEASE RENEWAL / heartbeat (review round 5 fix #2): a sender whose current
   * chunk's network call could outlive its lease renews claimed_at BEFORE the
   * call, so a slow-but-alive delivery can no longer be double-claimed by the
   * sweeper mid-flight. Combined with the Telegram send timeout (< lease) a
   * single renewed lease always covers one request. Fenced by the claim token
   * — false means another worker owns the row and the caller must abort.
   */
  async renewDeliveryClaim(messageId: string, claimToken: string): Promise<boolean> {
    const rows = await this.repo.query(
      `UPDATE messages
          SET claimed_at = now()
        WHERE id = $1 AND COALESCE(meta ->> 'claim_token', '') = $2::text
        RETURNING id`,
      [messageId, claimToken],
    );
    return rows.length > 0;
  }

  /**
   * Terminal SENT write — FENCED by the claim token (review fix): only the
   * CURRENT owner can finish a message. A zombie whose lease expired matches
   * 0 rows; null is returned and the caller must treat the send as lost.
   * The backoff schedule is cleared — a SENT message is never due again.
   */
  async markSent(
    messageId: string,
    telegramMessageId: string | null,
    claimToken: string,
  ): Promise<Message | null> {
    const rows = await this.repo.query(
      `UPDATE messages
          SET delivery_status = 'SENT',
              telegram_message_id = $2::bigint,
              sent_at = now(),
              error = NULL,
              claimed_at = NULL,
              next_attempt_at = NULL
        WHERE id = $1 AND COALESCE(meta ->> 'claim_token', '') = $3::text
        RETURNING *`,
      [messageId, telegramMessageId, claimToken],
    );
    const updated = firstRawRow<Message>(rows);
    if (updated) this.events.emit('message.updated', { message: updated });
    return updated;
  }

  /**
   * Transient failure → FAILED with the NEXT attempt SCHEDULED (review round 5
   * fix — real backoff): `nextAttemptAt` comes from computeRetryBackoffMs, so
   * the sweeper skips the row until its slot instead of hammering Telegram
   * every 15 s. The attempt counter was already consumed at claim time — this
   * write only records the outcome — and the write is fenced by the claim
   * token. Passing NO nextAttemptAt keeps the existing schedule (used only by
   * older callers; the dispatcher always passes one).
   */
  async markFailed(
    messageId: string,
    error: string,
    claimToken: string,
    nextAttemptAt?: Date,
  ): Promise<Message | null> {
    const rows = await this.repo.query(
      `UPDATE messages
          SET delivery_status = 'FAILED',
              error = LEFT($2::text, 500),
              claimed_at = NULL,
              next_attempt_at = COALESCE($4::timestamptz, next_attempt_at)
        WHERE id = $1 AND COALESCE(meta ->> 'claim_token', '') = $3::text
        RETURNING *`,
      [messageId, error, claimToken, nextAttemptAt?.toISOString() ?? null],
    );
    const updated = firstRawRow<Message>(rows);
    if (updated) this.events.emit('message.updated', { message: updated });
    return updated;
  }

  /** Terminal failure (403 blocked / chat not found / telegram disabled) — sweeper
   *  stops retrying and the backoff schedule is cleared. Fenced by the claim
   *  token (review fix). */
  async markPermanentlyFailed(
    messageId: string,
    error: string,
    claimToken: string,
  ): Promise<Message | null> {
    const rows = await this.repo.query(
      `UPDATE messages
          SET delivery_status = 'FAILED',
              error = LEFT($2::text, 500),
              delivery_attempts = $4,
              claimed_at = NULL,
              next_attempt_at = NULL
        WHERE id = $1 AND COALESCE(meta ->> 'claim_token', '') = $3::text
        RETURNING *`,
      [messageId, error, claimToken, MAX_DELIVERY_ATTEMPTS],
    );
    const updated = firstRawRow<Message>(rows);
    if (updated) this.events.emit('message.updated', { message: updated });
    return updated;
  }

  /** Telegram 429 — park the message until retry_after elapses (meta.retry_after_until);
   *  the explicit Telegram signal replaces the computed backoff, so
   *  next_attempt_at is cleared here. Fenced by the claim token; the attempt
   *  was consumed at claim time. */
  async deferRetry(
    messageId: string,
    retryAfterSeconds: number,
    claimToken: string,
  ): Promise<Message | null> {
    const until = new Date(Date.now() + retryAfterSeconds * 1000);
    const rows = await this.repo.query(
      `UPDATE messages
          SET delivery_status = 'FAILED',
              error = LEFT($2::text, 500),
              claimed_at = NULL,
              next_attempt_at = NULL,
              meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('retry_after_until', $4::timestamptz)
        WHERE id = $1 AND COALESCE(meta ->> 'claim_token', '') = $3::text
        RETURNING *`,
      [messageId, `rate limited by Telegram — retry after ${retryAfterSeconds}s`, claimToken, until.toISOString()],
    );
    const updated = firstRawRow<Message>(rows);
    if (updated) this.events.emit('message.updated', { message: updated });
    return updated;
  }

  /**
   * MANUAL RETRY from the panel (review round 5 fix): re-arms a FAILED message
   * — attempts reset, backoff schedule and error cleared, claim fencing and a
   * stale 429 deferral removed — while the multi-chunk progress (sent_chunks /
   * first_telegram_message_id) is KEPT so the retry resumes at the first UNSENT
   * chunk instead of duplicating delivered parts. Emits message.retry_requested
   * (the dispatcher drives the immediate delivery) and message.updated (the
   * panel's badge flips to "Sending…"). Returns null when the row is missing
   * or not FAILED — callers answer 404 / 409.
   */
  async retryFailedMessage(messageId: string, ticketId?: string): Promise<Message | null> {
    const rows = await this.repo.query(
      `UPDATE messages
          SET delivery_status = 'PENDING',
              delivery_attempts = 0,
              error = NULL,
              claimed_at = NULL,
              next_attempt_at = NULL,
              meta = COALESCE(meta, '{}'::jsonb) - 'claim_token' - 'retry_after_until'
        WHERE id = $1
          AND delivery_status = 'FAILED'
          AND ($2::uuid IS NULL OR ticket_id = $2::uuid)
        RETURNING *`,
      [messageId, ticketId ?? null],
    );
    const updated = firstRawRow<Message>(rows);
    if (updated) {
      this.events.emit('message.retry_requested', { message: updated });
      this.events.emit('message.updated', { message: updated });
    }
    return updated;
  }

  /**
   * Durable per-chunk progress for multi-part messages (review fix): after
   * EVERY successfully delivered chunk the count is committed, so a retry
   * (sweeper or crash recovery) resumes at the first UNSENT chunk instead of
   * re-sending already-delivered parts to the user. The first chunk's Telegram
   * message id is kept as the conversation anchor. Atomic jsonb merge — other
   * meta keys (model, retry_after_until, claim_token…) are preserved.
   *
   * FENCED by the claim token (review fix): the write only succeeds while the
   * CURRENT claim owner is still the one sending. Returns false when the claim
   * was lost (expired lease → another worker re-claimed) — the caller must
   * STOP sending further chunks immediately.
   *
   * At-least-once honesty: a hard crash between the Telegram send of a chunk
   * and this commit can re-send that ONE chunk on recovery — documented, and
   * exactly the residual window of the delivery semantics.
   */
  async recordChunkSent(
    messageId: string,
    sentChunks: number,
    firstTelegramMessageId: string | null,
    claimToken: string,
  ): Promise<boolean> {
    const rows = await this.repo.query(
      `UPDATE messages
          SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object(
                'sent_chunks', $2::int,
                'first_telegram_message_id', COALESCE($3::text, meta->>'first_telegram_message_id')
              )
        WHERE id = $1 AND COALESCE(meta ->> 'claim_token', '') = $4::text
        RETURNING id`,
      [messageId, sentChunks, firstTelegramMessageId, claimToken],
    );
    return rows.length > 0;
  }

  /**
   * Multi-part progress carried on the row (review fix): how many chunks were
   * already delivered, and the Telegram message id of the first chunk.
   */
  static readChunkProgress(message: Message): { sentChunks: number; firstTelegramMessageId: string | null } {
    const meta = (message.meta ?? {}) as Record<string, unknown>;
    const sentChunks = typeof meta.sent_chunks === 'number' && meta.sent_chunks >= 0
      ? meta.sent_chunks
      : 0;
    const firstTelegramMessageId =
      typeof meta.first_telegram_message_id === 'string' ? meta.first_telegram_message_id : null;
    return { sentChunks, firstTelegramMessageId };
  }

  /** The claim token of the worker that owns THIS delivery attempt (review fix). */
  static readClaimToken(message: Message): string {
    const meta = (message.meta ?? {}) as Record<string, unknown>;
    return typeof meta.claim_token === 'string' ? meta.claim_token : '';
  }

  private async touchTicket(ticket_id: string): Promise<void> {
    await this.dataSource
      .getRepository(Ticket)
      .update({ id: ticket_id }, { last_message_at: new Date() });
  }
}
