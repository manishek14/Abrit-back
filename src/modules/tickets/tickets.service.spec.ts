import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { TicketsService } from './tickets.service';
import { EventsService } from '../../common/events/events.service';
import { Ticket } from '../../database/entities/ticket.entity';
import { DeliveryStatus, MessageRole, TicketStatus } from '../../database/enums';

const mkTicket = (over: Partial<Ticket> = {}): Ticket =>
  ({
    id: 't-1',
    ticket_number: 'TKT-10001',
    user_id: 'u-1',
    status: TicketStatus.OPEN,
    subject: null,
    created_at: new Date(),
    updated_at: new Date(),
    last_message_at: new Date(),
    closed_at: null,
    ...over,
  }) as Ticket;

describe('TicketsService', () => {
  let service: TicketsService;
  let repo: {
    findOne: jest.Mock;
    findOneBy: jest.Mock;
    findOneByOrFail: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
  };
  let events: { emit: jest.Mock };
  let manager: { findOne: jest.Mock; update: jest.Mock; getRepository: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      findOneByOrFail: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
    };
    events = { emit: jest.fn() };
    manager = {
      findOne: jest.fn(),
      update: jest.fn(),
      getRepository: jest.fn().mockReturnValue({
        create: (x: unknown) => x,
        save: jest.fn(async (x: Record<string, unknown>) => ({ id: 'm-1', ...x })),
      }),
    };
    dataSource = {
      transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(manager)),
    };
    service = new TicketsService(
      repo as unknown as Repository<Ticket>,
      events as unknown as EventsService,
      dataSource as unknown as DataSource,
    );
  });

  describe('ensureActiveTicket', () => {
    it('returns the existing active ticket without creating', async () => {
      repo.findOne.mockResolvedValueOnce(mkTicket());
      const res = await service.ensureActiveTicket('u-1', 'موضوع');
      expect(res.created).toBe(false);
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('creates a ticket when none is active and emits ticket.created', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      repo.insert.mockResolvedValueOnce({ identifiers: [{ id: 't-1' }] });
      repo.findOneByOrFail.mockResolvedValueOnce(mkTicket());

      const res = await service.ensureActiveTicket('u-1', 'مشکل در پرداخت');
      expect(res.created).toBe(true);
      expect(repo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 'u-1', subject: 'مشکل در پرداخت' }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'ticket.created',
        expect.objectContaining({ ticket: expect.objectContaining({ id: 't-1' }) }),
      );
    });

    it('recovers from the concurrent-insert race (23505) by re-reading the winner', async () => {
      repo.findOne
        .mockResolvedValueOnce(null) // no active ticket → try insert
        .mockResolvedValueOnce(mkTicket({ id: 't-winner' })); // refetch after violation
      repo.insert.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));

      const res = await service.ensureActiveTicket('u-1', null);
      expect(res.created).toBe(false);
      expect(res.ticket.id).toBe('t-winner');
    });
  });

  describe('changeStatus', () => {
    it('rejects an unknown status value with 400', async () => {
      await expect(
        service.changeStatus('t-1', 'HACKED' as TicketStatus),
      ).rejects.toThrow(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('404s when the ticket does not exist', async () => {
      manager.findOne.mockResolvedValueOnce(null);
      await expect(service.changeStatus('t-x', TicketStatus.OPEN)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('same status = no-op without update or system message', async () => {
      manager.findOne.mockResolvedValueOnce(mkTicket());
      const res = await service.changeStatus('t-1', TicketStatus.OPEN);
      expect(res.changed).toBe(false);
      expect(res.systemMessage).toBeNull();
      expect(manager.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('valid transition updates row, inserts SYSTEM PENDING message and emits events', async () => {
      manager.findOne.mockResolvedValueOnce(mkTicket());

      const res = await service.changeStatus('t-1', TicketStatus.IN_PROGRESS);
      expect(res.changed).toBe(true);
      expect(manager.update).toHaveBeenCalledWith(
        Ticket,
        't-1',
        expect.objectContaining({ status: TicketStatus.IN_PROGRESS, closed_at: null }),
      );
      expect(res.systemMessage?.role).toBe(MessageRole.SYSTEM);
      expect(res.systemMessage?.delivery_status).toBe(DeliveryStatus.PENDING);
      expect(res.systemMessage?.content).toContain('در حال بررسی');
      expect(events.emit).toHaveBeenCalledWith(
        'ticket.status_changed',
        expect.objectContaining({ previousStatus: TicketStatus.OPEN }),
      );
    });

    it('setting CLOSED stamps closed_at', async () => {
      manager.findOne.mockResolvedValueOnce(mkTicket());
      await service.changeStatus('t-1', TicketStatus.CLOSED);
      expect(manager.update).toHaveBeenCalledWith(
        Ticket,
        't-1',
        expect.objectContaining({ status: TicketStatus.CLOSED, closed_at: expect.any(Date) }),
      );
    });

    it('reopening a CLOSED ticket fails with 409 while another active ticket exists', async () => {
      manager.findOne.mockImplementation(async (_cls, opts) => {
        const where = (opts as { where: { id?: string } }).where;
        return where?.id
          ? mkTicket({ id: 't-1', status: TicketStatus.CLOSED })
          : mkTicket({ id: 't-OTHER' });
      });

      await expect(service.changeStatus('t-1', TicketStatus.OPEN)).rejects.toThrow(
        ConflictException,
      );
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('review fix #4-a: CLOSED → IN_PROGRESS with another active ticket is ALSO a 409 (not a 500)', async () => {
      manager.findOne.mockImplementation(async (_cls, opts) => {
        const where = (opts as { where: { id?: string } }).where;
        return where?.id
          ? mkTicket({ id: 't-1', status: TicketStatus.CLOSED })
          : mkTicket({ id: 't-OTHER' });
      });

      await expect(service.changeStatus('t-1', TicketStatus.IN_PROGRESS)).rejects.toThrow(
        ConflictException,
      );
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('review fix #3: events fire only AFTER the transaction commits', async () => {
      manager.findOne.mockResolvedValueOnce(mkTicket());
      // the transaction body runs, but the COMMIT itself fails — the events
      // queued inside the callback must never be fired
      dataSource.transaction.mockImplementationOnce(async (cb: (m: unknown) => Promise<unknown>) => {
        await cb(manager);
        throw new Error('commit failed');
      });

      await expect(service.changeStatus('t-1', TicketStatus.CLOSED)).rejects.toThrow('commit failed');
      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});
