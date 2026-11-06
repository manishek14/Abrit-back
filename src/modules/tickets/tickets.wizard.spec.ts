import { DataSource, Repository } from 'typeorm';
import { TicketsService } from './tickets.service';
import { EventsService } from '../../common/events/events.service';
import { Ticket } from '../../database/entities/ticket.entity';
import { Message } from '../../database/entities/message.entity';
import { DeliveryStatus, MessageRole, TicketDepartment, TicketStatus } from '../../database/enums';
import { isUniqueViolation } from '../../common/utils/pg-errors';

jest.mock('../../common/utils/pg-errors', () => ({
  ...jest.requireActual('../../common/utils/pg-errors'),
}));

const mkTicket = (over: Partial<Ticket> = {}): Ticket =>
  ({
    id: 't-1',
    ticket_number: 'TKT-10001',
    user_id: 'u-1',
    status: TicketStatus.OPEN,
    subject: null,
    created_at: new Date(),
    last_message_at: new Date(),
    ...over,
  }) as Ticket;

/**
 * Unit tests for the WIZARD-side TicketsService methods (feature round):
 * createTicketWithFirstMessage (transactional + idempotent) and listUserTickets.
 */
describe('TicketsService — wizard creation & user listing (feature §2/§3)', () => {
  let service: TicketsService;
  let repo: Record<string, jest.Mock>;
  let events: { emit: jest.Mock };
  let manager: Record<string, jest.Mock>;
  let dataSource: { transaction: jest.Mock };

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      findOneByOrFail: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };
    events = { emit: jest.fn() };
    manager = {
      insert: jest.fn(),
      findOneByOrFail: jest.fn(),
      update: jest.fn(),
      getRepository: jest.fn().mockReturnValue({
        create: (x: unknown) => x,
        save: jest.fn(async (x: Record<string, unknown>) => ({ id: 'm-1', ...x })),
        insert: jest.fn().mockResolvedValue({}),
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

  describe('createTicketWithFirstMessage', () => {
    const input = {
      user_id: 'u-1',
      subject: 'مشکل در ورود به حساب',
      department: TicketDepartment.TECHNICAL,
      description: 'متن کامل درخواست کاربر',
      telegram_update_id: '9001',
    };

    it('commits ticket + USER description + SYSTEM announcement in ONE transaction', async () => {
      manager.insert.mockResolvedValueOnce({ identifiers: [{ id: 't-1' }] });
      manager.findOneByOrFail.mockResolvedValueOnce(mkTicket({ subject: input.subject, department: input.department }));

      const out = await service.createTicketWithFirstMessage(input);

      expect(out.created).toBe(true);
      const msgRepo = manager.getRepository();
      expect(msgRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          ticket_id: 't-1',
          role: MessageRole.USER,
          content: input.description,
          telegram_update_id: '9001',
        }),
      );
      expect(msgRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          role: MessageRole.SYSTEM,
          delivery_status: DeliveryStatus.PENDING,
        }),
      );
      expect(events.emit).toHaveBeenCalledWith('ticket.created', expect.anything());
      expect(events.emit).toHaveBeenCalledWith('message.created', expect.anything());
    });

    it('is IDEMPOTENT on the update id: a unique violation resolves to the EXISTING ticket', async () => {
      manager.insert.mockRejectedValueOnce({ code: '23505', detail: 'uq_messages_telegram_update_id' });
      repo.query.mockResolvedValueOnce([{ ticket_id: 't-existing' }]);
      repo.findOneBy.mockResolvedValueOnce(mkTicket({ id: 't-existing' }));

      const out = await service.createTicketWithFirstMessage(input);

      expect(out.created).toBe(false);
      expect(out.ticket.id).toBe('t-existing');
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('on the active-ticket RACE (partial unique index) returns the winner, never throws', async () => {
      manager.insert.mockRejectedValueOnce({ code: '23505', detail: 'uq_active_ticket_per_user' });
      repo.query.mockResolvedValueOnce([]); // no stored message for this update
      repo.findOne.mockResolvedValueOnce(mkTicket({ id: 't-winner' }));

      const out = await service.createTicketWithFirstMessage(input);

      expect(out.created).toBe(false);
      expect(out.ticket.id).toBe('t-winner');
    });

    it('a NON-unique DB error propagates (caller keeps the wizard state for retry)', async () => {
      manager.insert.mockRejectedValueOnce(new Error('connection reset'));
      await expect(service.createTicketWithFirstMessage(input)).rejects.toThrow('connection reset');
    });
  });

  describe('listUserTickets', () => {
    it('queries ONLY the user tickets with pagination and newest-first order', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[mkTicket()], 7]),
      };
      repo.createQueryBuilder.mockReturnValue(qb);

      const out = await service.listUserTickets('u-1', 2, 5);

      expect(qb.where).toHaveBeenCalledWith('t.user_id = :user_id', { user_id: 'u-1' });
      expect(qb.orderBy).toHaveBeenCalledWith('t.created_at', 'DESC');
      expect(qb.skip).toHaveBeenCalledWith(5);
      expect(qb.take).toHaveBeenCalledWith(5);
      expect(out).toEqual({ data: [expect.anything()], meta: { page: 2, limit: 5, total: 7 } });
    });
  });
});

// silence the unused-import lint in constrained setups
void Message;
