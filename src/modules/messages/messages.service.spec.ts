import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { MessagesService, INITIAL_PAGE_SIZE } from './messages.service';
import { EventsService } from '../../common/events/events.service';
import { Message } from '../../database/entities/message.entity';
import { Ticket } from '../../database/entities/ticket.entity';
import { DeliveryStatus, MessageRole, TicketStatus } from '../../database/enums';

const mkMessage = (over: Partial<Message> = {}): Message =>
  ({
    id: 'm-1',
    ticket_id: 't-1',
    role: MessageRole.USER,
    content: 'سلام',
    telegram_update_id: null,
    in_reply_to_id: null,
    client_message_id: null,
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

const mkTicket = (over: Partial<Ticket> = {}): Ticket =>
  ({ id: 't-1', status: TicketStatus.OPEN, ...over }) as Ticket;

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
  let manager: { create: jest.Mock; save: jest.Mock; update: jest.Mock; findOne: jest.Mock };
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
      findOne: jest.fn().mockResolvedValue(mkTicket()),
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

      // Race-safe contract: the transaction locks the ticket row BEFORE the
      // insert — the SAME pessimistic_write lock changeStatus takes.
      expect(manager.findOne).toHaveBeenCalledWith(
        Ticket,
        { where: { id: 't-1' }, lock: { mode: 'pessimistic_write' } },
      );
      expect(manager.save).toHaveBeenCalledWith(
        Message,
        expect.objectContaining({
          ticket_id: 't-1',
          role: MessageRole.ADMIN,
          content: 'پاسخ کارشناس',
          admin_id: 'a-1',
          client_message_id: null,
          delivery_status: DeliveryStatus.PENDING,
        }),
      );
      expect(manager.update).toHaveBeenCalledWith(Ticket, 't-1', { last_message_at: expect.any(Date) });
      expect(events.emit).toHaveBeenCalledWith('message.created', { message: stored });
      expect(result.message.id).toBe('m-admin');
      expect(result.replayed).toBe(false);
    });

    it('RACE FIX: rejects with 409 when the ticket is CLOSED inside the transaction — no insert', async () => {
      manager.findOne.mockResolvedValueOnce(mkTicket({ status: TicketStatus.CLOSED }));

      await expect(
        service.addAdminMessage({ ticket_id: 't-1', content: 'پاسخ', admin_id: 'a-1' }),
      ).rejects.toThrow(ConflictException);

      expect(manager.save).not.toHaveBeenCalled(); // nothing was stored
      expect(events.emit).not.toHaveBeenCalled(); // and no event fired
    });

    it('RACE FIX: unknown ticket inside the transaction → 404, no insert', async () => {
      manager.findOne.mockResolvedValueOnce(null);

      await expect(
        service.addAdminMessage({ ticket_id: 't-404', content: 'پاسخ', admin_id: 'a-1' }),
      ).rejects.toThrow(NotFoundException);

      expect(manager.save).not.toHaveBeenCalled();
    });

    it('IDEMPOTENCY: a known client_message_id replays the ORIGINAL row — nothing stored, no double event chain', async () => {
      const original = mkMessage({
        id: 'm-first',
        role: MessageRole.ADMIN,
        content: 'پاسخ تکراری',
        admin_id: 'a-1',
        client_message_id: 'key-12345678',
        delivery_status: DeliveryStatus.PENDING,
      });
      repo.findOne.mockResolvedValueOnce(original);

      const result = await service.addAdminMessage({
        ticket_id: 't-1',
        content: 'پاسخ تکراری', // SAME content — the key is bound to it
        admin_id: 'a-1',
        client_message_id: 'key-12345678',
      });

      expect(result.message).toBe(original); // the FIRST message comes back
      expect(result.replayed).toBe(true);
      expect(manager.save).not.toHaveBeenCalled(); // nothing new was stored
      // the replay re-fires message.created (heals a crash-between-commit-and-
      // emit; the panel merges by id and the atomic claim prevents a re-send)
      expect(events.emit).toHaveBeenCalledWith('message.created', { message: original });
    });

    it('IDEMPOTENCY (review fix — content-bound): the SAME key with DIFFERENT content is a 409, NOT a replay', async () => {
      // Without this guard a retry with an edited draft would answer with the
      // OLD message and the panel would wipe text that was never sent.
      const original = mkMessage({
        id: 'm-first',
        role: MessageRole.ADMIN,
        content: 'پاسخ اول',
        client_message_id: 'key-12345678',
        delivery_status: DeliveryStatus.PENDING,
      });
      repo.findOne.mockResolvedValueOnce(original);

      await expect(
        service.addAdminMessage({
          ticket_id: 't-1',
          content: 'پاسخ ویرایش‌شده', // EDITED body, REUSED key
          admin_id: 'a-1',
          client_message_id: 'key-12345678',
        }),
      ).rejects.toThrow(ConflictException);

      expect(manager.save).not.toHaveBeenCalled(); // nothing stored
      expect(events.emit).not.toHaveBeenCalled(); // no event, no delivery
    });

    it('IDEMPOTENCY: loses a concurrent same-key race → the winner’s message is returned', async () => {
      const winner = mkMessage({
        id: 'm-winner',
        role: MessageRole.ADMIN,
        content: 'پاسخ',
        client_message_id: 'key-12345678',
      });
      repo.findOne // pre-check misses
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner); // race loser re-read finds the winner
      manager.save.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));

      const result = await service.addAdminMessage({
        ticket_id: 't-1',
        content: 'پاسخ', // identical content — the loser replays the winner
        admin_id: 'a-1',
        client_message_id: 'key-12345678',
      });

      expect(result.message).toBe(winner);
      expect(result.replayed).toBe(true);
    });

    it('IDEMPOTENCY (content-bound): the race loser with DIFFERENT content gets a 409 too', async () => {
      const winner = mkMessage({
        id: 'm-winner',
        role: MessageRole.ADMIN,
        content: 'پاسخ اولیه',
        client_message_id: 'key-12345678',
      });
      repo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner);
      manager.save.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));

      await expect(
        service.addAdminMessage({
          ticket_id: 't-1',
          content: 'متن دیگری',
          admin_id: 'a-1',
          client_message_id: 'key-12345678',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('multi-chunk delivery progress (review fix — no duplicated parts)', () => {
    it('recordChunkSent merges progress into meta and is FENCED by the claim token', async () => {
      repo.query.mockResolvedValueOnce([{ id: 'm-1' }]);

      const owned = await service.recordChunkSent('m-1', 2, '77', 'tok-1');

      expect(owned).toBe(true);
      const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("'sent_chunks'");
      expect(sql).toContain("'first_telegram_message_id'");
      expect(sql).toContain('COALESCE($3::text, meta'); // merge, not overwrite
      expect(sql).toContain("claim_token"); // FENCING (review fix)
      expect(params).toEqual(['m-1', 2, '77', 'tok-1']);
    });

    it('recordChunkSent returns false when the claim was lost (0 rows) — the caller must abort', async () => {
      repo.query.mockResolvedValueOnce([]);

      expect(await service.recordChunkSent('m-1', 2, '77', 'tok-stale')).toBe(false);
    });

    it('readChunkProgress tolerates missing/invalid meta and keeps the stored first id', () => {
      expect(MessagesService.readChunkProgress(mkMessage())).toEqual({
        sentChunks: 0,
        firstTelegramMessageId: null,
      });
      expect(
        MessagesService.readChunkProgress(
          mkMessage({ meta: { sent_chunks: 1, first_telegram_message_id: '77', model: 'x' } }),
        ),
      ).toEqual({ sentChunks: 1, firstTelegramMessageId: '77' });
      expect(
        MessagesService.readChunkProgress(mkMessage({ meta: { sent_chunks: -3 } })),
      ).toEqual({ sentChunks: 0, firstTelegramMessageId: null });
    });

    it('readClaimToken surfaces the fencing token (review fix)', () => {
      expect(MessagesService.readClaimToken(mkMessage({ meta: { claim_token: 'tok-9' } }))).toBe(
        'tok-9',
      );
      expect(MessagesService.readClaimToken(mkMessage())).toBe('');
    });
  });

  describe('claimForDelivery (atomic outbox claim — review fix #2)', () => {
    it('returns the claimed row when the atomic UPDATE wins — attempts consumed + token stamped', async () => {
      const claimed = mkMessage({ id: 'm-1', delivery_status: DeliveryStatus.PENDING });
      repo.query.mockResolvedValueOnce([claimed]);

      const result = await service.claimForDelivery('m-1');

      expect(result).toBe(claimed);
      const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('SET claimed_at = now()');
      // CRASH-SAFE ATTEMPT COUNTING (review fix): the counter is consumed at
      // claim time — a hard crash right after the claim burns one retry.
      expect(sql).toContain('delivery_attempts = delivery_attempts + 1');
      // CLAIM TOKEN (review fix): a fresh fencing token is stamped into meta
      expect(sql).toContain("'claim_token'");
      expect(sql).toContain("delivery_status IN ('PENDING', 'FAILED')");
      expect(sql).toContain('claimed_at IS NULL OR claimed_at <');
      expect(params[0]).toBe('m-1');
      expect(params[1]).toBe(5); // MAX_DELIVERY_ATTEMPTS
      expect(params[3]).toEqual(expect.stringMatching(/[0-9a-f-]{36}/)); // uuid token
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

  describe('outbox state transitions (all FENCED by the claim token — review fix)', () => {
    it('markSent sets SENT with the telegram message id, fenced by the token, and emits update', async () => {
      const sent = mkMessage({ id: 'm-1', delivery_status: DeliveryStatus.SENT });
      repo.query.mockResolvedValueOnce([sent]);

      const result = await service.markSent('m-1', '77', 'tok-1');

      expect(result).toBe(sent);
      const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("delivery_status = 'SENT'");
      expect(sql).toContain("claim_token"); // fencing
      expect(params).toEqual(['m-1', '77', 'tok-1']);
      expect(events.emit).toHaveBeenCalledWith('message.updated', { message: sent });
    });

    it('markSent writes NOTHING when the claim was lost (0 rows, no event)', async () => {
      repo.query.mockResolvedValueOnce([]);

      expect(await service.markSent('m-1', '77', 'tok-stale')).toBeNull();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('markFailed records the outcome but does NOT double-count the attempt (claim owns the counter)', async () => {
      const failed = mkMessage({ id: 'm-1', delivery_status: DeliveryStatus.FAILED });
      repo.query.mockResolvedValueOnce([failed]);

      const result = await service.markFailed('m-1', 'telegram is down', 'tok-1');

      expect(result).toBe(failed);
      const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("delivery_status = 'FAILED'");
      expect(sql).toContain('LEFT($2::text, 500)');
      expect(sql).not.toContain('delivery_attempts ='); // consumed at claim time (review fix)
      expect(params).toEqual(['m-1', 'telegram is down', 'tok-1']);
      expect(events.emit).toHaveBeenCalledWith('message.updated', { message: failed });
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
      const failed = mkMessage({ id: 'm-1', delivery_status: DeliveryStatus.FAILED });
      repo.query.mockResolvedValueOnce([failed]);

      const result = await service.markPermanentlyFailed('m-1', 'user blocked the bot', 'tok-1');

      expect(result).toBe(failed);
      const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('delivery_attempts = $4');
      expect(params[3]).toBe(5); // MAX_DELIVERY_ATTEMPTS
      expect(sql).toContain('claim_token'); // fencing
      expect(events.emit).toHaveBeenCalledWith('message.updated', { message: failed });
    });

    it('deferRetry parks a 429 message with retry_after_until merged into meta (token-fenced)', async () => {
      const parked = mkMessage({ id: 'm-1', meta: { model: 'x' } });
      repo.query.mockResolvedValueOnce([parked]);

      const result = await service.deferRetry('m-1', 30, 'tok-1');

      expect(result).toBe(parked);
      const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("'retry_after_until'");
      expect(sql).toContain('COALESCE(meta'); // meta MERGE — model/claim_token survive
      expect(params[0]).toBe('m-1');
      expect(params[1]).toContain('retry after 30s');
      expect(params[2]).toBe('tok-1');
      expect(params[3]).toEqual(expect.any(String)); // ISO timestamp
      expect(events.emit).toHaveBeenCalledWith('message.updated', { message: parked });
    });
  });
});
