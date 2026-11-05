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
    findOne: jest.Mock;
    findOneBy: jest.Mock;
    findOneByOrFail: jest.Mock;
    createQueryBuilder: jest.Mock;
    query: jest.Mock;
  };
  let events: { emit: jest.Mock };
  let dataSource: { getRepository: jest.Mock };

  beforeEach(() => {
    repo = {
      create: (x) => x,
      save: jest.fn(),
      update: jest.fn(),
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      findOneByOrFail: jest.fn(),
      createQueryBuilder: jest.fn(),
      query: jest.fn(),
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

    it('RESUMES a crashed attempt: duplicate telegram_update_id returns the existing row', async () => {
      const existing = mkMessage({ id: 'm-old', telegram_update_id: '555' });
      repo.save.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
      repo.findOne.mockResolvedValueOnce(existing);

      const result = await service.addUserMessage({
        ticket_id: 't-1',
        content: 'سلام',
        telegram_update_id: '555',
      });

      expect(result).toBe(existing); // caller continues with the reply step
      expect(events.emit).not.toHaveBeenCalled(); // no duplicate message.created
    });

    it('maps an unresolvable duplicate to ConflictException', async () => {
      repo.save.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
      repo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.addUserMessage({ ticket_id: 't-1', content: 'سلام', telegram_update_id: '555' }),
      ).rejects.toThrow(ConflictException);
    });

    it('findAssistantReply looks up the single ASSISTANT row by in_reply_to_id', async () => {
      repo.findOne.mockResolvedValueOnce(mkMessage({ role: MessageRole.ASSISTANT }));
      await service.findAssistantReply('m-1');
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { in_reply_to_id: 'm-1', role: MessageRole.ASSISTANT },
      });
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

  describe('claimForDelivery (atomic outbox claim — review fix #2)', () => {
    it('returns the claimed row when the atomic UPDATE wins', async () => {
      const claimed = mkMessage({ id: 'm-1', delivery_status: DeliveryStatus.PENDING });
      repo.query.mockResolvedValueOnce([claimed]);

      const result = await service.claimForDelivery('m-1');

      expect(result).toBe(claimed);
      const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('SET claimed_at = now()');
      expect(sql).toContain("delivery_status IN ('PENDING', 'FAILED')");
      expect(sql).toContain('claimed_at IS NULL OR claimed_at <');
      expect(params[0]).toBe('m-1');
      expect(params[1]).toBe(5); // MAX_DELIVERY_ATTEMPTS
    });

    it('returns null when another sender owns the claim (0 rows)', async () => {
      repo.query.mockResolvedValueOnce([]);
      expect(await service.claimForDelivery('m-1')).toBeNull();
    });
  });

  describe('getConversationPage (cursor pagination — review fix)', () => {
    const mkQb = () => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    });

    it('backward page: limit older-than-cursor rows, ascending, with has_more', async () => {
      const qb = mkQb();
      // DB returns DESC (newest-first): [7, 6, 5] are all older than cursor 8
      qb.getMany.mockResolvedValueOnce([
        mkMessage({ id: '7' }),
        mkMessage({ id: '6' }),
        mkMessage({ id: '5' }),
      ]);
      repo.createQueryBuilder.mockReturnValueOnce(qb);

      const page = await service.getConversationPage('t-1', { before: '8', limit: 2 });

      expect(qb.andWhere).toHaveBeenCalledWith('m.id < :before', { before: '8' });
      expect(qb.orderBy).toHaveBeenCalledWith('m.id', 'DESC');
      expect(qb.take).toHaveBeenCalledWith(3); // limit + 1 for has_more
      // the page holds the `limit` messages CLOSEST to the cursor, ascending
      expect(page.messages.map((m) => m.id)).toEqual(['6', '7']);
      expect(page.has_more).toBe(true); // message 5 still exists below
    });

    it('forward/full load: ascending rows and has_more when the page is full', async () => {
      const qb = mkQb();
      qb.getMany.mockResolvedValueOnce([
        mkMessage({ id: '1' }),
        mkMessage({ id: '2' }),
        mkMessage({ id: '3' }),
      ]);
      repo.createQueryBuilder.mockReturnValueOnce(qb);

      const page = await service.getConversationPage('t-1', { limit: 2 });

      expect(qb.andWhere).not.toHaveBeenCalled(); // no after cursor
      expect(page.messages.map((m) => m.id)).toEqual(['1', '2']);
      expect(page.has_more).toBe(true);
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
    it('scans only PENDING/FAILED rows below the attempt cap and respects retry_after', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      repo.createQueryBuilder.mockReturnValueOnce(qb);

      const due = await service.findDueOutbox(10, { freshWindowMs: 5_000 });
      expect(due).toEqual([]);
      expect(qb.where).toHaveBeenCalledWith(
        'm.delivery_status IN (:...statuses)',
        { statuses: [DeliveryStatus.PENDING, DeliveryStatus.FAILED] },
      );
      expect(qb.andWhere).toHaveBeenCalledWith('m.delivery_attempts < :max', { max: 5 });
      expect(qb.andWhere).toHaveBeenCalledWith(expect.stringContaining('retry_after_until'));
      expect(qb.andWhere).toHaveBeenCalledWith('m.created_at < :cutoff', { cutoff: expect.any(Date) });
    });
  });

  describe('permanent failure & rate-limit deferral', () => {
    it('markPermanentlyFailed caps attempts so the sweeper never retries again', async () => {
      repo.findOneByOrFail.mockResolvedValue(mkMessage());

      await service.markPermanentlyFailed('m-1', 'user blocked the bot');

      expect(repo.update).toHaveBeenCalledWith(
        { id: 'm-1' },
        expect.objectContaining({ delivery_status: DeliveryStatus.FAILED, delivery_attempts: 5 }),
      );
      expect(events.emit).toHaveBeenCalledWith('message.updated', expect.anything());
    });

    it('deferRetry parks a 429 message with retry_after_until in meta', async () => {
      repo.findOneByOrFail.mockResolvedValue(mkMessage({ meta: { model: 'x' } }));

      await service.deferRetry('m-1', 30);

      expect(repo.update).toHaveBeenCalledWith(
        { id: 'm-1' },
        expect.objectContaining({
          delivery_status: DeliveryStatus.FAILED,
          delivery_attempts: 1,
          meta: expect.objectContaining({
            model: 'x',
            retry_after_until: expect.any(String),
          }),
        }),
      );
    });
  });
});
