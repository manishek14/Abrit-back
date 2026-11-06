import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, Not, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Ticket } from '../../database/entities/ticket.entity';
import { Message } from '../../database/entities/message.entity';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { DeliveryStatus, MessageRole, TicketStatus } from '../../database/enums';
import { EventsService } from '../../common/events/events.service';
import { isUniqueViolation } from '../../common/utils/pg-errors';
import { escapeLike, Paginated, toPaginated } from '../../common/pagination';
import { TICKET_STATUS_LABELS } from '../../common/ticket-labels';
import { TicketDepartment } from '../../database/enums';

export interface ChangeStatusResult {
  ticket: Ticket;
  systemMessage: Message | null;
  /** false = same-status no-op (HTTP 200, no duplicate notification). */
  changed: boolean;
}

export interface EnsureActiveTicketResult {
  ticket: Ticket;
  created: boolean;
  /**
   * The ticket-creation announcement, stored IN THE SAME transaction as the
   * ticket itself (review fix — crash window closed): a crash between the two
   * inserts is impossible, so a retry can never find a ticket whose opening
   * SYSTEM message went missing. Null when the ticket already existed.
   */
  announcement: Message | null;
}

@Injectable()
export class TicketsService {
  constructor(
    @InjectRepository(Ticket) private readonly repo: Repository<Ticket>,
    private readonly events: EventsService,
    private readonly dataSource: DataSource,
  ) {}

  async findActiveTicket(user_id: string): Promise<Ticket | null> {
    return this.repo.findOne({ where: { user_id, status: Not(TicketStatus.CLOSED) } });
  }

  async findLastTicket(user_id: string): Promise<Ticket | null> {
    return this.repo.findOne({ where: { user_id }, order: { created_at: 'DESC' } });
  }

  async findByNumber(ticket_number: string): Promise<Ticket | null> {
    return this.repo.findOneBy({ ticket_number });
  }

  async findById(id: string): Promise<Ticket | null> {
    return this.repo.findOneBy({ id });
  }

  /**
   * Returns the user's active ticket, creating one if none exists.
   * Race-safe: two concurrent requests both try INSERT; the partial unique index
   * rejects the loser, which then re-reads the winner's ticket.
   * (subject = first 60 chars of the triggering message.)
   *
   * ATOMIC CREATION ANNOUNCEMENT (review fix): when `opts.announce` is given,
   * the SYSTEM outbox message is written in the SAME transaction as the
   * ticket — previously the two were separate writes, and a hard crash
   * between them left a ticket whose opening announcement never existed (the
   * retry saw `created = false` and never re-announced). Events fire only
   * after the commit, per the message-creation contract.
   */
  async ensureActiveTicket(
    user_id: string,
    subject: string | null,
    opts: { announce?: (ticketNumber: string) => string } = {},
  ): Promise<EnsureActiveTicketResult> {
    const existing = await this.findActiveTicket(user_id);
    if (existing) return { ticket: existing, created: false, announcement: null };

    try {
      // filled inside the transaction, emitted only after it commits
      let announcement: Message | null = null;

      const ticket = await this.dataSource.transaction(async (manager) => {
        const insertResult = await manager.insert(Ticket, { user_id, subject: subject ?? null });
        const id = insertResult.identifiers[0]?.id as string;
        // ticket_number is DB-generated (sequence) → reload to expose it
        const created = await manager.findOneByOrFail(Ticket, { id });

        if (opts.announce) {
          const msgRepo = manager.getRepository(Message);
          announcement = await msgRepo.save(
            msgRepo.create({
              ticket_id: id,
              role: MessageRole.SYSTEM,
              content: opts.announce(created.ticket_number),
              delivery_status: DeliveryStatus.PENDING,
            }),
          );
          // the announcement is a message — the list's sort key must move too
          const now = new Date();
          await manager.update(Ticket, id, { last_message_at: now });
          created.last_message_at = now;
        }
        return created;
      });

      this.events.emit('ticket.created', { ticket });
      if (announcement) this.events.emit('message.created', { message: announcement });
      return { ticket, created: true, announcement };
    } catch (e) {
      if (isUniqueViolation(e)) {
        const winner = await this.findActiveTicket(user_id);
        if (winner) return { ticket: winner, created: false, announcement: null };
      }
      throw e;
    }
  }

  /**
   * The ticket wizard's FINAL step (feature round §3) — one transaction:
   *   ticket (subject + department) → USER message (description, keyed by the
   *   telegram update) → SYSTEM announcement (outbox, PENDING).
   * Idempotency walls (both pre-existing):
   *   - uq_messages_telegram_update_id → a sweeper retry of the same update
   *     can never store the description twice (the caller checks first via
   *     findByTelegramUpdateId — this constraint is the race-proof backstop);
   *   - uq_active_ticket_per_user → if another active ticket appeared while
   *     the user was in the wizard, the insert loses and we return that
   *     ticket with created=false (no leaking 500).
   * On failure the caller keeps the wizard state so the user can retry
   * without losing their inputs (§4: DB error ⇒ no success message).
   */
  async createTicketWithFirstMessage(input: {
    user_id: string;
    subject: string;
    department: TicketDepartment;
    description: string;
    telegram_update_id: string;
  }): Promise<{ ticket: Ticket; created: boolean; announcement: Message | null }> {
    try {
      let announcement: Message | null = null;

      const ticket = await this.dataSource.transaction(async (manager) => {
        const insertResult = await manager.insert(Ticket, {
          user_id: input.user_id,
          subject: input.subject,
          department: input.department,
        });
        const id = insertResult.identifiers[0]?.id as string;
        const created = await manager.findOneByOrFail(Ticket, { id });

        const msgRepo = manager.getRepository(Message);

        // the user's description is the FIRST message of the conversation
        await msgRepo.insert({
          ticket_id: id,
          role: MessageRole.USER,
          content: input.description,
          telegram_update_id: input.telegram_update_id,
        });

        announcement = await msgRepo.save(
          msgRepo.create({
            ticket_id: id,
            role: MessageRole.SYSTEM,
            content: `تیکت ${created.ticket_number} با عنوان «${input.subject}» در دپارتمان «${input.department}» ثبت شد.`,
            delivery_status: DeliveryStatus.PENDING,
          }),
        );
        const now = new Date();
        await manager.update(Ticket, id, { last_message_at: now });
        created.last_message_at = now;
        return created;
      });

      this.events.emit('ticket.created', { ticket });
      if (announcement) this.events.emit('message.created', { message: announcement });
      return { ticket, created: true, announcement };
    } catch (e) {
      if (isUniqueViolation(e)) {
        // either the description was already stored (sweeper retry) or another
        // active ticket won the race — both resolve to existing data, never 500
        const stored = await this.repo.query(
          `SELECT ticket_id FROM messages WHERE telegram_update_id = $1 LIMIT 1`,
          [input.telegram_update_id],
        );
        if (stored.length > 0) {
          const existing = await this.repo.findOneBy({ id: stored[0].ticket_id });
          if (existing) return { ticket: existing, created: false, announcement: null };
        }
        const winner = await this.findActiveTicket(input.user_id);
        if (winner) return { ticket: winner, created: false, announcement: null };
      }
      throw e;
    }
  }

  /** /mytickets (feature round §2): ONLY this user's tickets, newest first. */
  async listUserTickets(
    user_id: string,
    page: number,
    limit: number,
  ): Promise<Paginated<Ticket>> {
    const [items, total] = await this.repo
      .createQueryBuilder('t')
      .where('t.user_id = :user_id', { user_id })
      .orderBy('t.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return toPaginated(items, total, page, limit);
  }

  /**
   * Status change — one short transaction:
   *   row lock → validations → UPDATE (+closed_at) → INSERT SYSTEM outbox message (PENDING).
   * The SYSTEM insert happens INSIDE the transaction (transactional-outbox: it
   * survives any crash), while the in-process events fire only AFTER a
   * successful commit (review fix #3) so the panel/dispatcher never see a
   * change that could still roll back. The sweeper remains the safety net.
   *
   * Rules (plan §6 + review fix #4-a): same status = no-op 200; unknown status
   * = 400; moving a CLOSED ticket to ANY active status (OPEN or IN_PROGRESS)
   * is allowed only if the user has no other active ticket — mirroring the
   * partial unique index exactly, so the answer is a controlled 409 instead
   * of a leaking 500.
   */
  async changeStatus(
    ticketId: string,
    newStatus: TicketStatus,
    by: 'ADMIN' | 'USER' = 'ADMIN',
  ): Promise<ChangeStatusResult> {
    if (!Object.values(TicketStatus).includes(newStatus)) {
      throw new BadRequestException(`Invalid ticket status: ${String(newStatus)}`);
    }

    // Filled inside the transaction, fired after it commits (fix #3).
    const afterCommit: Array<() => void> = [];

    let result: ChangeStatusResult;
    try {
      result = await this.dataSource.transaction(async (manager) => {
        const ticket = await manager.findOne(Ticket, {
          where: { id: ticketId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!ticket) throw new NotFoundException('Ticket not found');

        if (ticket.status === newStatus) {
          return { ticket, systemMessage: null, changed: false };
        }

        // ANY transition CLOSED → active status collides with the partial
        // unique index when the user owns another active ticket (fix #4-a).
        if (newStatus !== TicketStatus.CLOSED && ticket.status === TicketStatus.CLOSED) {
          const otherActive = await manager.findOne(Ticket, {
            where: { user_id: ticket.user_id, status: Not(TicketStatus.CLOSED) },
          });
          if (otherActive && otherActive.id !== ticket.id) {
            throw new ConflictException('User already has another active ticket');
          }
        }

        const previousStatus = ticket.status;
        const now = new Date();
        await manager.update(Ticket, ticket.id, {
          status: newStatus,
          closed_at: newStatus === TicketStatus.CLOSED ? now : null,
          updated_at: now,
          // Review fix #5: the status change ALSO appends a SYSTEM message to
          // the conversation — the ticket's last-activity stamp (which the list
          // is sorted by) must reflect it, in the SAME transaction.
          last_message_at: now,
        });

        const content =
          by === 'USER'
            ? `تیکت ${ticket.ticket_number} به درخواست شما به «${TICKET_STATUS_LABELS[newStatus]}» تغییر کرد.`
            : `وضعیت تیکت ${ticket.ticket_number} توسط کارشناس پشتیبانی به «${TICKET_STATUS_LABELS[newStatus]}» تغییر کرد.`;
        const msgRepo = manager.getRepository(Message);
        const systemMessage = await msgRepo.save(
          msgRepo.create({
            ticket_id: ticket.id,
            role: MessageRole.SYSTEM,
            content,
            delivery_status: DeliveryStatus.PENDING,
          }),
        );

        const updatedTicket: Ticket = {
          ...ticket,
          status: newStatus,
          closed_at: newStatus === TicketStatus.CLOSED ? now : null,
          updated_at: now,
          last_message_at: now,
        };

        // Deferred until the transaction has actually committed (fix #3).
        afterCommit.push(() => {
          this.events.emit('ticket.status_changed', { ticket: updatedTicket, previousStatus, systemMessage });
          this.events.emit('message.created', { message: systemMessage });
        });

        return { ticket: updatedTicket, systemMessage, changed: true };
      });
    } catch (e) {
      // Race safety net: another ticket became active between the check above
      // and the UPDATE — the partial unique index rejected us (fix #4-a).
      if (isUniqueViolation(e)) {
        throw new ConflictException('User already has another active ticket');
      }
      throw e;
    }

    for (const fire of afterCommit) fire();
    return result;
  }

  /** Admin list — filter by status, search by number (with/without TKT- prefix),
   *  last-activity order, and the OWNER embedded per ticket (review fix: the
   *  panel shows the user's name, not an internal uuid). */
  async listTickets(params: {
    status?: TicketStatus;
    q?: string;
    page: number;
    limit: number;
  }): Promise<Paginated<Ticket>> {
    const { status, q, page, limit } = params;
    const qb = this.repo
      .createQueryBuilder('t')
      .leftJoinAndMapOne('t.user', TelegramUser, 'u', 'u.id = t.user_id');

    if (status) qb.andWhere('t.status = :status', { status });
    if (q) {
      const normalized = this.normalizeNumberQuery(q);
      qb.andWhere('t.ticket_number ILIKE :like', { like: `%${escapeLike(normalized)}%` });
    }

    const [items, total] = await qb
      .orderBy('t.last_message_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return toPaginated(items, total, page, limit);
  }

  async getTicketWithUser(id: string): Promise<Ticket> {
    const ticket = await this.repo.findOne({ where: { id }, relations: { user: true } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  /** Accepts 10001, TKT-10001, tkt-10001 … → TKT-10001 (partial, case-insensitive). */
  private normalizeNumberQuery(q: string): string {
    const trimmed = q.trim().toUpperCase();
    return trimmed.startsWith('TKT-') ? trimmed : `TKT-${trimmed}`;
  }
}
