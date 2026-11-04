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
import { DeliveryStatus, MessageRole, TicketStatus } from '../../database/enums';
import { EventsService } from '../../common/events/events.service';
import { isUniqueViolation } from '../../common/utils/pg-errors';
import { escapeLike, Paginated, toPaginated } from '../../common/pagination';
import { TICKET_STATUS_LABELS } from '../../common/ticket-labels';

export interface ChangeStatusResult {
  ticket: Ticket;
  systemMessage: Message | null;
  /** false = same-status no-op (HTTP 200, no duplicate notification). */
  changed: boolean;
}

export interface EnsureActiveTicketResult {
  ticket: Ticket;
  created: boolean;
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
   */
  async ensureActiveTicket(
    user_id: string,
    subject: string | null,
  ): Promise<EnsureActiveTicketResult> {
    const existing = await this.findActiveTicket(user_id);
    if (existing) return { ticket: existing, created: false };

    try {
      const insertResult = await this.repo.insert({ user_id, subject: subject ?? null });
      const id = insertResult.identifiers[0]?.id as string;
      // ticket_number is DB-generated (sequence) → reload to expose it
      const ticket = await this.repo.findOneByOrFail({ id });
      this.events.emit('ticket.created', { ticket });
      return { ticket, created: true };
    } catch (e) {
      if (isUniqueViolation(e)) {
        const winner = await this.findActiveTicket(user_id);
        if (winner) return { ticket: winner, created: false };
      }
      throw e;
    }
  }

  /**
   * Status change — one short transaction:
   *   row lock → validations → UPDATE (+closed_at) → INSERT SYSTEM outbox message (PENDING).
   * The dispatcher (telegram module) sends right after commit; the sweeper is the safety net,
   * so "status changed ⇒ notification definitely arrives".
   *
   * Rules (plan §6): same status = no-op 200; unknown status = 400; reopening a CLOSED
   * ticket is allowed only if the user has no other active ticket (409 otherwise).
   */
  async changeStatus(
    ticketId: string,
    newStatus: TicketStatus,
    by: 'ADMIN' | 'USER' = 'ADMIN',
  ): Promise<ChangeStatusResult> {
    if (!Object.values(TicketStatus).includes(newStatus)) {
      throw new BadRequestException(`Invalid ticket status: ${String(newStatus)}`);
    }

    return this.dataSource.transaction(async (manager) => {
      const ticket = await manager.findOne(Ticket, {
        where: { id: ticketId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!ticket) throw new NotFoundException('Ticket not found');

      if (ticket.status === newStatus) {
        return { ticket, systemMessage: null, changed: false };
      }

      if (newStatus === TicketStatus.OPEN && ticket.status === TicketStatus.CLOSED) {
        const otherActive = await manager.findOne(Ticket, {
          where: { user_id: ticket.user_id, status: Not(TicketStatus.CLOSED) },
        });
        if (otherActive && otherActive.id !== ticket.id) {
          throw new ConflictException('User already has another active ticket');
        }
      }

      const previousStatus = ticket.status;
      await manager.update(Ticket, ticket.id, {
        status: newStatus,
        closed_at: newStatus === TicketStatus.CLOSED ? new Date() : null,
        updated_at: new Date(),
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
        closed_at: newStatus === TicketStatus.CLOSED ? new Date() : null,
        updated_at: new Date(),
      };

      this.events.emit('ticket.status_changed', { ticket: updatedTicket, previousStatus, systemMessage });
      this.events.emit('message.created', { message: systemMessage });

      return { ticket: updatedTicket, systemMessage, changed: true };
    });
  }

  /** Admin list — filter by status, search by number (with/without TKT- prefix), last-activity order. */
  async listTickets(params: {
    status?: TicketStatus;
    q?: string;
    page: number;
    limit: number;
  }): Promise<Paginated<Ticket>> {
    const { status, q, page, limit } = params;
    const qb = this.repo.createQueryBuilder('t');

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
