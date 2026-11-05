import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Message } from '../../database/entities/message.entity';
import { Ticket } from '../../database/entities/ticket.entity';
import { DeliveryStatus, MessageRole } from '../../database/enums';
import { EventsService } from '../../common/events/events.service';
import { isUniqueViolation } from '../../common/utils/pg-errors';
import { firstRawRow } from '../../common/utils/raw-rows';

/** Send attempts per outbound message (immediate + sweeper retries, backoff respected). */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Delivery lease: a claimed message cannot be re-claimed for this long (review fix #2). */
export const DELIVERY_LEASE_MS = 60_000;

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
   * Stores a user message and touches ticket.last_message_at.
   *
   * RESUME semantics (review fix #1): a unique violation on telegram_update_id
   * can only mean a PREVIOUS attempt stored this message and crashed before
   * finishing (ingest dedups update_id; claim dedups concurrent workers). So
   * instead of failing we return the existing row and let the caller continue
   * with the reply step — half-finished work is resumed, never dropped.
   */
  async addUserMessage(input: AddUserMessageInput): Promise<Message> {
    try {
      const saved = await this.repo.save(
        this.repo.create({
          ticket_id: input.ticket_id,
          role: MessageRole.USER,
          content: input.content,
          telegram_update_id: input.telegram_update_id ?? null,
        }),
      );
      await this.touchTicket(input.ticket_id);
      this.events.emit('message.created', { message: saved });
      return saved;
    } catch (e) {
      if (isUniqueViolation(e) && input.telegram_update_id) {
        const existing = await this.repo.findOne({
          where: { telegram_update_id: input.telegram_update_id },
        });
        if (existing) return existing; // crash resume — no event, no touch
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

  /**
   * Outbox insert — every outbound message (AI, admin, system notification) is
   * persisted as PENDING BEFORE any network attempt, so a crash can never lose it.
   * Unique violation on in_reply_to_id = the ASSISTANT already replied to this
   * user message (retry after crash) → ConflictException.
   */
  async addOutboundMessage(input: AddOutboundMessageInput): Promise<Message> {
    try {
      const saved = await this.repo.save(
        this.repo.create({
          ticket_id: input.ticket_id,
          role: input.role,
          content: input.content,
          in_reply_to_id: input.in_reply_to_id ?? null,
          admin_id: input.admin_id ?? null,
          meta: input.meta ?? null,
          delivery_status: DeliveryStatus.PENDING,
        }),
      );
      await this.touchTicket(input.ticket_id);
      this.events.emit('message.created', { message: saved });
      return saved;
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('An assistant reply for this message already exists');
      }
      throw e;
    }
  }

  /**
   * Conversation history in order.
   * `after` — cheap incremental refresh by last seen id (returns newer).
   * `before` — backward pagination for older history (returns the `limit`
   *            messages immediately older than the cursor, still ascending).
   * `has_more` — whether more (older) messages exist beyond this page.
   */
  async getConversationPage(
    ticket_id: string,
    options: { after?: string; before?: string; limit?: number } = {},
  ): Promise<{ messages: Message[]; has_more: boolean }> {
    const limit = Math.min(options.limit ?? 1000, 1000);

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

    const qb = this.repo
      .createQueryBuilder('m')
      .where('m.ticket_id = :ticket_id', { ticket_id })
      .orderBy('m.id', 'ASC')
      .take(limit + 1);

    if (options.after) {
      qb.andWhere('m.id > :after', { after: options.after });
    }

    const rows = await qb.getMany();
    const has_more = rows.length > limit;
    return { messages: rows.slice(0, limit), has_more };
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
   *  retry_after deferrals respected, optionally skipping fresh rows that the
   *  immediate dispatcher may still be sending. */
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
   */
  async claimForDelivery(
    messageId: string,
    leaseMs: number = DELIVERY_LEASE_MS,
  ): Promise<Message | null> {
    const rows = await this.repo.query(
      `UPDATE messages
          SET claimed_at = now()
        WHERE id = $1
          AND delivery_status IN ('PENDING', 'FAILED')
          AND delivery_attempts < $2
          AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $3))
          AND NOT (
            meta ->> 'retry_after_until' IS NOT NULL
            AND (meta ->> 'retry_after_until')::timestamptz > now()
          )
        RETURNING *`,
      [messageId, MAX_DELIVERY_ATTEMPTS, Math.max(1, Math.round(leaseMs / 1000))],
    );
    return firstRawRow<Message>(rows);
  }

  async markSent(messageId: string, telegram_message_id: string | null): Promise<Message> {
    await this.repo.update(
      { id: messageId },
      {
        delivery_status: DeliveryStatus.SENT,
        telegram_message_id,
        sent_at: new Date(),
        error: null,
        claimed_at: null,
      },
    );
    const updated = await this.repo.findOneByOrFail({ id: messageId });
    this.events.emit('message.updated', { message: updated });
    return updated;
  }

  /** Failed send → FAILED (retryable while attempts < MAX; the sweeper picks it up with backoff). */
  async markFailed(messageId: string, error: string): Promise<Message> {
    const current = await this.repo.findOneByOrFail({ id: messageId });
    await this.repo.update(
      { id: messageId },
      {
        delivery_status: DeliveryStatus.FAILED,
        error: error.slice(0, 500),
        delivery_attempts: current.delivery_attempts + 1,
        claimed_at: null, // release the lease — next sweeper pass may retry
      },
    );
    const updated = await this.repo.findOneByOrFail({ id: messageId });
    this.events.emit('message.updated', { message: updated });
    return updated;
  }

  /** Terminal failure (403 blocked / chat not found / telegram disabled) — sweeper stops retrying. */
  async markPermanentlyFailed(messageId: string, error: string): Promise<void> {
    await this.repo.update(
      { id: messageId },
      {
        delivery_status: DeliveryStatus.FAILED,
        error: error.slice(0, 500),
        delivery_attempts: MAX_DELIVERY_ATTEMPTS,
        claimed_at: null,
      },
    );
    const updated = await this.repo.findOneByOrFail({ id: messageId });
    this.events.emit('message.updated', { message: updated });
  }

  /** Telegram 429 — park the message until retry_after elapses (meta.retry_after_until). */
  async deferRetry(messageId: string, retryAfterSeconds: number): Promise<void> {
    const current = await this.repo.findOneByOrFail({ id: messageId });
    const until = new Date(Date.now() + retryAfterSeconds * 1000);
    await this.repo.update(
      { id: messageId },
      {
        delivery_status: DeliveryStatus.FAILED,
        error: `rate limited by Telegram — retry after ${retryAfterSeconds}s`,
        delivery_attempts: current.delivery_attempts + 1,
        claimed_at: null, // retry_after_until (not the lease) now gates the retry
        meta: { ...(current.meta ?? {}), retry_after_until: until.toISOString() },
      },
    );
    const updated = await this.repo.findOneByOrFail({ id: messageId });
    this.events.emit('message.updated', { message: updated });
  }

  private async touchTicket(ticket_id: string): Promise<void> {
    await this.dataSource
      .getRepository(Ticket)
      .update({ id: ticket_id }, { last_message_at: new Date() });
  }
}
