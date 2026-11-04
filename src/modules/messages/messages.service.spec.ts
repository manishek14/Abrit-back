import { ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { MessagesService } from './messages.service';
import { EventsService } from '../../common/events/events.service';
import { Message } from '../../database/entities/message.entity';
import { Ticket } from '../../database/entities/ticket.entity';
import { DeliveryStatus, MessageRole } from '../../database/enums';

const mkMessage = (over: Partial<Message> = {}): Message =>
  ({
    id: 'm-1',
    ticket_id: 't-1',
    role: MessageRole.USER,
    content: 'سلام',
    telegram_update_id: null,
    in_reply_to_id: null,
    delivery_status: null,
    delivery_attempts: 0,
    error: null,
    telegram_message_id: null,
    admin_id: null,
    meta: null,
    created_at: new Date(),
    sent_at: null,
    ...over,
  }) as Message;

describe('MessagesService', () => {
  let service: MessagesService;
  let repo: {
    create: (x: Record<string, unknown>) => Record<string, unknown>;
    save: jest.Mock;
    update: jest.Mock;
    findOneBy: jest.Mock;
    findOneByOrFail: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let events: { emit: jest.Mock };
  let dataSource: { getRepository: jest.Mock };

  beforeEach(() => {
    repo = {
      create: (x) => x,
      save: jest.fn(),
      update: jest.fn(),
      findOneBy: jest.fn(),
      findOneByOrFail: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    events = { emit: jest.fn() };
    dataSource = { getRepository: jest.fn().mockReturnValue({ update: jest.fn() }) };
    service = new MessagesService(
      repo as unknown as Repository<Message>,
      events as unknown as EventsService,
      dataSource as unknown as DataSource,
    );
  });

  describe('addUserMessage', () => {
    it('stores a USER message, touches the ticket and emits message.created', async () => {
      repo.save.mockResolvedValueOnce(mkMessage({ id: 'm-9' }));

      const saved = await service.addUserMessage({
        ticket_id: 't-1',
        content: 'سلام',
        telegram_update_id: '555',
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          ticket_id: 't-1',
          role: MessageRole.USER,
          content: 'سلام',
          telegram_update_id: '555',
        }),
      );
      expect(dataSource.getRepository(Ticket).update).toHaveBeenCalledWith(
        { id: 't-1' },
        { last_message_at: expect.any(Date) },
      );
      expect(events.emit).toHaveBeenCalledWith(
        'message.created',
        expect.objectContaining({ message: expect.objectContaining({ id: 'm-9' }) }),
      );
      expect(saved.id).toBe('m-9');
    });

    it('maps a duplicate telegram_update_id to ConflictException', async () => {
      repo.save.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
      await expect(
        service.addUserMessage({ ticket_id: 't-1', content: 'سلام', telegram_update_id: '555' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('addOutboundMessage', () => {
    it('persists every outbound message as PENDING before any send attempt', async () => {
      repo.save.mockImplementationOnce(async (x: Record<string, unknown>) =>
        mkMessage({ ...(x as Partial<Message>), id: 'm-2' }),
      );

      const saved = await service.addOutboundMessage({
        ticket_id: 't-1',
        role: MessageRole.ASSISTANT,
        content: 'پاسخ هوش مصنوعی',
        in_reply_to_id: 'm-1',
        meta: { model: 'openrouter/auto', latencyMs: 700 },
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ delivery_status: DeliveryStatus.PENDING, role: MessageRole.ASSISTANT }),
      );
      expect(saved.delivery_status).toBe(DeliveryStatus.PENDING);
      expect(events.emit).toHaveBeenCalledWith('message.created', expect.anything());
    });

    it('treats a duplicate assistant reply (unique in_reply_to_id) as a conflict', async () => {
      repo.save.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
      await expect(
        service.addOutboundMessage({
          ticket_id: 't-1',
          role: MessageRole.ASSISTANT,
          content: 'پاسخ',
          in_reply_to_id: 'm-1',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('outbox state transitions', () => {
    it('markSent sets SENT with the telegram message id and emits update', async () => {
      repo.findOneByOrFail.mockResolvedValue(mkMessage({ delivery_status: DeliveryStatus.SENT }));

      await service.markSent('m-1', '77');

      expect(repo.update).toHaveBeenCalledWith(
        { id: 'm-1' },
        expect.objectContaining({
          delivery_status: DeliveryStatus.SENT,
          telegram_message_id: '77',
          sent_at: expect.any(Date),
          error: null,
        }),
      );
      expect(events.emit).toHaveBeenCalledWith('message.updated', expect.anything());
    });

    it('markFailed sets FAILED and increments attempts', async () => {
      repo.findOneByOrFail.mockResolvedValue(
        mkMessage({ delivery_status: DeliveryStatus.FAILED, delivery_attempts: 2 }),
      );

      await service.markFailed('m-1', 'telegram is down');

      expect(repo.update).toHaveBeenCalledWith(
        { id: 'm-1' },
        expect.objectContaining({
          delivery_status: DeliveryStatus.FAILED,
          error: 'telegram is down',
          delivery_attempts: 3,
        }),
      );
    });
  });

  describe('findDueOutbox', () => {
    it('scans only PENDING/FAILED rows below the attempt cap', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      repo.createQueryBuilder.mockReturnValueOnce(qb);

      const due = await service.findDueOutbox(10);
      expect(due).toEqual([]);
      expect(qb.where).toHaveBeenCalledWith(
        'm.delivery_status IN (:...statuses)',
        { statuses: [DeliveryStatus.PENDING, DeliveryStatus.FAILED] },
      );
      expect(qb.andWhere).toHaveBeenCalledWith('m.delivery_attempts < :max', { max: 5 });
    });
  });
});
