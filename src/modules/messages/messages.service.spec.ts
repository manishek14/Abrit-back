import { ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { MessagesService, INITIAL_PAGE_SIZE } from './messages.service';
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
  /** Transactional manager handed to persistWithTouch by the mocked DataSource. */
  let manager: { create: jest.Mock; save: jest.Mock; update: jest.Mock };
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };

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
    manager = {
      create: jest.fn((entity, x) => x),
      save: jest.fn(),
      update: jest.fn(),
    };
    dataSource = {
      getRepository: jest.fn().mockReturnValue({ update: jest.fn() }),
      transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(manager)),
    };
    service = new MessagesService(
      repo as unknown as Repository<Message>,
      events as unknown as EventsService,
      dataSource as unknown as DataSource,
    );
  });

  describe('addUserMessage (message-creation contract)', () => {
    it('stores a USER message, touches the ticket and emits message.created AFTER the commit', async () => {
      const saved = mkMessage({ id: 'm-9' });
      manager.save.mockResolvedValueOnce(saved);

      const result = await service.addUserMessage({
        ticket_id: 't-1',
        content: 'سلام',
        telegram_update_id: '555',
      });

      expect(manager.save).toHaveBeenCalledWith(
        Message,
        expect.objectContaining({
          ticket_id: 't-1',
          role: MessageRole.USER,
          content: 'سلام',
          telegram_update_id: '555',
        }),
      );
      // the touch lives in the SAME transaction as the insert (contract #1)
      expect(manager.update).toHaveBeenCalledWith(
        Ticket,
        't-1',
        { last_message_at: expect.any(Date) },
      );
      // the event fires only after the commit (contract #2)
      expect(events.emit).toHaveBeenCalledWith(
        'message.created',
        expect.objectContaining({ message: expect.objectContaining({ id: 'm-9' }) }),
      );
      expect(result.id).toBe('m-9');
    });

    it('RESUMES a crashed attempt: the existing row is returned AND its event re-published (review fix #5)', async () => {
      const existing = mkMessage({ id: 'm-old', telegram_update_id: '555' });
      manager.save.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
      repo.findOne.mockResolvedValueOnce(existing);

      const result = await service.addUserMessage({
        ticket_id: 't-1',
        content: 'سلام',
        telegram_update_id: '555',
      });

      expect(result).toBe(existing); // caller continues with the reply step
      // the previous attempt may have died before the event went out, so the
      // resume re-touches the ticket and re-publishes message.created — the
      // panel merges by id, so a live listener can never be left behind.
      expect(dataSource.getRepository(Ticket).update).toHaveBeenCalledWith(
        { id: 't-1' },
        { last_message_at: expect.any(Date) },
      );
      expect(events.emit).toHaveBeenCalledWith('message.created', {
        message: existing,
      });
    });

    it('maps an unresolvable duplicate to ConflictException', async () => {
      manager.save.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
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
      manager.save.mockImplementationOnce(async (cls, x: Record<string, unknown>) =>
        mkMessage({ ...(x as Partial<Message>), id: 'm-2' }),
      );

      const saved = await service.addOutboundMessage({
        ticket_id: 't-1',
        role: MessageRole.ASSISTANT,
        content: 'پاسخ هوش مصنوعی',
        in_reply_to_id: 'm-1',
        meta: { model: 'openrouter/auto', latencyMs: 700 },
      });

      expect(manager.save).toHaveBeenCalledWith(
        Message,
        expect.objectContaining({ delivery_status: DeliveryStatus.PENDING, role: MessageRole.ASSISTANT }),
      );
      expect(manager.update).toHaveBeenCalledWith(Ticket, 't-1', { last_message_at: expect.any(Date) });
      expect(saved.delivery_status).toBe(DeliveryStatus.PENDING);
      expect(events.emit).toHaveBeenCalledWith('message.created', expect.anything());
    });

    it('treats a duplicate assistant reply (unique in_reply_to_id) as a conflict', async () => {
      manager.save.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
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

  describe('addAdminMessage (operator replies — review fix #4)', () => {
    it('stores an ADMIN outbox row with admin_id, touches the ticket and emits after commit', async () => {
      const stored = mkMessage({
        id: 'm-admin',
        role: MessageRole.ADMIN,
        content: 'پاسخ کارشناس',
        admin_id: 'a-1',
        delivery_status: DeliveryStatus.PENDING,
      });
      manager.save.mockResolvedValueOnce(stored);

      const result = await service.addAdminMessage({
        ticket_id: 't-1',
        content: 'پاسخ کارشناس',
        admin_id: 'a-1',
      });

      expect(manager.save).toHaveBeenCalledWith(
        Message,
        expect.objectContaining({
          ticket_id: 't-1',
          role: MessageRole.ADMIN,
          content: 'پاسخ کارشناس',
          admin_id: 'a-1',
          delivery_status: DeliveryStatus.PENDING,
        }),
      );
      expect(manager.update).toHaveBeenCalledWith(Ticket, 't-1', { last_message_at: expect.any(Date) });
      expect(events.emit).toHaveBeenCalledWith('message.created', { message: stored });
      expect(result.id).toBe('m-admin');
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

    it('initial page: the NEWEST `limit` messages ascending — the agent lands on the latest state', async () => {
      const qb = mkQb();
      // DB returns DESC (newest first): 1..7, limit 3 → slice [7,6,5] reversed
      qb.getMany.mockResolvedValueOnce([
        mkMessage({ id: '7' }),
        mkMessage({ id: '6' }),
        mkMessage({ id: '5' }),
        mkMessage({ id: '4' }),
      ]);
      repo.createQueryBuilder.mockReturnValueOnce(qb);

      const page = await service.getConversationPage('t-1', { limit: 3 });

      expect(qb.andWhere).not.toHaveBeenCalled(); // no cursor — initial page
      expect(qb.orderBy).toHaveBeenCalledWith('m.id', 'DESC'); // newest-first window
      expect(qb.take).toHaveBeenCalledWith(4); // limit + 1 for has_more
      expect(page.messages.map((m) => m.id)).toEqual(['5', '6', '7']); // ascending
      expect(page.has_more).toBe(true); // messages 1–4 still exist above
    });

    it('initial page defaults to INITIAL_PAGE_SIZE and caps at the hard max', async () => {
      const qb = mkQb();
      qb.getMany.mockResolvedValueOnce([]);
      repo.createQueryBuilder.mockReturnValueOnce(qb);

      await service.getConversationPage('t-1');

      expect(qb.take).toHaveBeenCalledWith(INITIAL_PAGE_SIZE + 1);
    });

    it('after-cursor: incremental refresh returns NEWER messages ascending', async () => {
      const qb = mkQb();
      qb.getMany.mockResolvedValueOnce([mkMessage({ id: '8' }), mkMessage({ id: '9' })]);
      repo.createQueryBuilder.mockReturnValueOnce(qb);

      const page = await service.getConversationPage('t-1', { after: '7', limit: 10 });

      expect(qb.andWhere).toHaveBeenCalledWith('m.id > :after', { after: '7' });
      expect(qb.orderBy).toHaveBeenCalledWith('m.id', 'ASC');
      expect(page.messages.map((m) => m.id)).toEqual(['8', '9']);
      expect(page.has_more).toBe(false);
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
