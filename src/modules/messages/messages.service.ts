import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Message } from '../../database/entities/message.entity';
import { Ticket } from '../../database/entities/ticket.entity';
import { DeliveryStatus, MessageRole } from '../../database/enums';
import { EventsService } from '../../common/events/events.service';
import { isUniqueViolation } from '../../common/utils/pg-errors';

/** Send attempts per outbound message (immediate + sweeper retries, backoff respected). */
export const MAX_DELIVERY_ATTEMPTS = 5;

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
   * Throws ConflictException when this telegram_update_id was already stored
   * (duplicate delivery/replay) — callers treat that as "already processed".
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
      if (isUniqueViolation(e)) {
        throw new ConflictException('Duplicate user message for this telegram update');
      }
      throw e;
    }
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

  /** Conversation history in order; `after` supports cheap panel refresh by last seen id. */
  async getConversation(
    ticket_id: string,
    options: { after?: string; limit?: number } = {},
  ): Promise<Message[]> {
    const qb = this.repo
      .createQueryBuilder('m')
      .where('m.ticket_id = :ticket_id', { ticket_id })
      .orderBy('m.id', 'ASC');

    if (options.after) {
      qb.andWhere('m.id > :after', { after: options.after });
    }

    return qb.take(options.limit ?? 1000).getMany();
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

  async markSent(messageId: string, telegram_message_id: string | null): Promise<Message> {
    await this.repo.update(
      { id: messageId },
      {
        delivery_status: DeliveryStatus.SENT,
        telegram_message_id,
        sent_at: new Date(),
        error: null,
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
