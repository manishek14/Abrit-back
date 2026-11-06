import {
  OutboxDispatcherService,
  splitForTelegram,
} from './outbox-dispatcher.service';
import {
  MessagesService,
  OUTBOX_RETRY_BASE_MS,
  OUTBOX_RETRY_MAX_MS,
  computeRetryBackoffMs,
} from '../messages/messages.service';
import { TicketsService } from '../tickets/tickets.service';
import { UsersService } from '../users/users.service';
import { EventsService } from '../../common/events/events.service';
import { Ticket } from '../../database/entities/ticket.entity';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { Message } from '../../database/entities/message.entity';
import { DeliveryStatus, MessageRole, TicketStatus } from '../../database/enums';
import { TelegramApiError, TelegramGateway } from './telegram-gateway.interface';

const mkMessage = (over: Partial<Message> = {}): Message =>
  ({
    id: 'm-1',
    ticket_id: 't-1',
    role: MessageRole.ASSISTANT,
    content: 'پاسخ دستیار',
    in_reply_to_id: null,
    delivery_status: DeliveryStatus.PENDING,
    delivery_attempts: 0,
    error: null,
    telegram_message_id: null,
    admin_id: null,
    meta: null,
    created_at: new Date(),
    sent_at: null,
    claimed_at: null,
    next_attempt_at: null,
    ...over,
  }) as Message;

const mkTicket = (over: Partial<Ticket> = {}): Ticket =>
  ({ id: 't-1', ticket_number: 'TKT-1', user_id: 'u-1', status: TicketStatus.OPEN, ...over }) as Ticket;

const mkUser = (over: Partial<TelegramUser> = {}): TelegramUser =>
  ({ id: 'u-1', telegram_id: '555', chat_id: '555', is_blocked: false, ...over }) as TelegramUser;

describe('OutboxDispatcherService', () => {
  let service: OutboxDispatcherService;
  let messages: {
    claimForDelivery: jest.Mock;
    renewDeliveryClaim: jest.Mock;
    markSent: jest.Mock;
    markFailed: jest.Mock;
    markPermanentlyFailed: jest.Mock;
    deferRetry: jest.Mock;
    recordChunkSent: jest.Mock;
  };
  let tickets: { findById: jest.Mock };
  let users: { findByIdOrNull: jest.Mock; setBlocked: jest.Mock; setBlockedIfNoNewerActivity: jest.Mock };
  let events: { on: jest.Mock };
  let gateway: TelegramGateway & { sendMessage: jest.Mock };

  beforeEach(() => {
    messages = {
      claimForDelivery: jest.fn(),
      // the lease renewal succeeds by default (review round 5: renewed before
      // every chunk send)
      renewDeliveryClaim: jest.fn().mockResolvedValue(true),
      markSent: jest.fn(),
      markFailed: jest.fn(),
      markPermanentlyFailed: jest.fn(),
      deferRetry: jest.fn(),
      // the fenced progress write succeeds by default (review fix: the
      // dispatcher now checks ownership on every chunk)
      recordChunkSent: jest.fn().mockResolvedValue(true),
    };
    tickets = { findById: jest.fn() };
    users = {
      findByIdOrNull: jest.fn(),
      setBlocked: jest.fn(),
      setBlockedIfNoNewerActivity: jest.fn().mockResolvedValue(true),
    };
    events = { on: jest.fn() };
    gateway = { active: true, sendMessage: jest.fn().mockResolvedValue({ message_id: '77' }) } as never;

    service = new OutboxDispatcherService(
      messages as unknown as MessagesService,
      tickets as unknown as TicketsService,
      users as unknown as UsersService,
      events as unknown as EventsService,
      gateway as unknown as TelegramGateway,
    );
  });

  it('review fix #2: loses the atomic claim → sends NOTHING (no duplicate send)', async () => {
    messages.claimForDelivery.mockResolvedValueOnce(null); // sweeper/other worker owns it

    await service.deliver(mkMessage());

    expect(gateway.sendMessage).not.toHaveBeenCalled();
    expect(messages.markSent).not.toHaveBeenCalled();
    expect(messages.markFailed).not.toHaveBeenCalled();
    expect(messages.markPermanentlyFailed).not.toHaveBeenCalled();
  });

  it('wins the claim → sends the (fresh) claimed row and marks it SENT (token-fenced writes)', async () => {
    const claimed = mkMessage({ id: 'm-9', content: 'متن جدید', meta: { claim_token: 'tok-9' } });
    messages.claimForDelivery.mockResolvedValueOnce(claimed);
    tickets.findById.mockResolvedValueOnce(mkTicket());
    users.findByIdOrNull.mockResolvedValueOnce(mkUser());

    await service.deliver(mkMessage({ id: 'm-stale' }));

    expect(messages.claimForDelivery).toHaveBeenCalledWith('m-stale');
    expect(gateway.sendMessage).toHaveBeenCalledWith({ chat_id: '555', text: 'متن جدید' });
    expect(messages.markSent).toHaveBeenCalledWith('m-9', '77', 'tok-9'); // FENCED by the claim token
  });

  describe('review round 5 fix #4 — race-safe 403 blocking', () => {
    it('403 with NO newer user activity → user is flagged blocked via the guarded write', async () => {
      const claimedAt = new Date(Date.now() - 60_000);
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({ meta: { claim_token: 'tok-1' }, claimed_at: claimedAt }),
      );
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());
      gateway.sendMessage.mockRejectedValueOnce(new TelegramApiError('blocked', 403, false));

      await service.deliver(mkMessage());

      // the OLD unguarded setBlocked(true) is gone — the 403 can no longer
      // blindly overwrite a newer unblocked state
      expect(users.setBlocked).not.toHaveBeenCalled();
      expect(users.setBlockedIfNoNewerActivity).toHaveBeenCalledWith('u-1', claimedAt);
      expect(messages.markPermanentlyFailed).toHaveBeenCalledWith('m-1', 'blocked', 'tok-1');
      expect(messages.markSent).not.toHaveBeenCalled();
    });

    it('403 with a missing claimed_at falls back to now() as the activity cutoff (defensive)', async () => {
      messages.claimForDelivery.mockResolvedValueOnce(mkMessage({ meta: { claim_token: 'tok-1' } }));
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());
      gateway.sendMessage.mockRejectedValueOnce(new TelegramApiError('blocked', 403, false));

      await service.deliver(mkMessage());

      const cutoff = users.setBlockedIfNoNewerActivity.mock.calls[0][1] as Date;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(Date.now() - 1000);
    });
  });

  describe('review round 5 fix #1 — real backoff on transient failures', () => {
    it('a transient TelegramApiError schedules the next attempt with exponential backoff', async () => {
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({ meta: { claim_token: 'tok-1' }, delivery_attempts: 3 }),
      );
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());
      gateway.sendMessage.mockRejectedValueOnce(new TelegramApiError('bad gateway', 502, false));

      await service.deliver(mkMessage());

      const [, error, token, nextAttemptAt] = messages.markFailed.mock.calls[0];
      expect(error).toBe('bad gateway');
      expect(token).toBe('tok-1');
      // attempt 3 failed → next attempt in ~2 × base (± 20% jitter)
      const delay = (nextAttemptAt as Date).getTime() - Date.now();
      const expected = OUTBOX_RETRY_BASE_MS * 4; // 2^(3-1)
      expect(delay).toBeGreaterThanOrEqual(expected * 0.79);
      expect(delay).toBeLessThanOrEqual(expected * 1.21);
    });

    it('a non-Telegram error (network down) is transient and schedules a backoff too', async () => {
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({ meta: { claim_token: 'tok-1' }, delivery_attempts: 1 }),
      );
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());
      gateway.sendMessage.mockRejectedValueOnce(new Error('network down'));

      await service.deliver(mkMessage());

      const [id, error, token, nextAttemptAt] = messages.markFailed.mock.calls[0];
      expect(id).toBe('m-1');
      expect(error).toBe('network down');
      expect(token).toBe('tok-1');
      const delay = (nextAttemptAt as Date).getTime() - Date.now();
      expect(delay).toBeGreaterThanOrEqual(OUTBOX_RETRY_BASE_MS * 0.79); // 1st failure → ~base
      expect(delay).toBeLessThanOrEqual(OUTBOX_RETRY_BASE_MS * 1.21);
    });

    it('a permanent TelegramApiError still terminates immediately (no backoff involved)', async () => {
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({ meta: { claim_token: 'tok-1' }, delivery_attempts: 1 }),
      );
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());
      gateway.sendMessage.mockRejectedValueOnce(
        new TelegramApiError('Bad Request: chat not found', 400, true),
      );

      await service.deliver(mkMessage());

      expect(messages.markPermanentlyFailed).toHaveBeenCalledWith(
        'm-1',
        'Bad Request: chat not found',
        'tok-1',
      );
      expect(messages.markFailed).not.toHaveBeenCalled();
    });
  });

  it('retryable error → markFailed (sweeper retries later)', async () => {
    messages.claimForDelivery.mockResolvedValueOnce(mkMessage({ meta: { claim_token: 'tok-1' } }));
    tickets.findById.mockResolvedValueOnce(mkTicket());
    users.findByIdOrNull.mockResolvedValueOnce(mkUser());
    gateway.sendMessage.mockRejectedValueOnce(new Error('network down'));

    await service.deliver(mkMessage());

    expect(messages.markFailed).toHaveBeenCalledWith(
      'm-1',
      'network down',
      'tok-1',
      expect.any(Date),
    );
  });

  it('onModuleInit: only outbound PENDING messages are picked from message.created', () => {
    service.onModuleInit();
    expect(events.on).toHaveBeenCalledWith('message.created', expect.any(Function));
    expect(events.on).toHaveBeenCalledWith('message.retry_requested', expect.any(Function));

    const handler = events.on.mock.calls[0][1] as (p: { message: Message }) => void;
    const spy = jest.spyOn(service, 'deliver').mockImplementation(async () => undefined);

    handler({ message: mkMessage() }); // ASSISTANT + PENDING → deliver
    handler({ message: mkMessage({ role: MessageRole.USER, delivery_status: null }) }); // user → skip
    handler({ message: mkMessage({ delivery_status: DeliveryStatus.SENT }) }); // already sent → skip

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('onModuleInit: a manual retry event drives an immediate delivery (review round 5)', () => {
    service.onModuleInit();
    const retryHandler = events.on.mock.calls.find(
      ([name]) => name === 'message.retry_requested',
    )?.[1] as ((p: { message: Message }) => void) | undefined;
    expect(retryHandler).toBeDefined();

    const spy = jest.spyOn(service, 'deliver').mockImplementation(async () => undefined);
    retryHandler!({ message: mkMessage() });
    expect(spy).toHaveBeenCalledTimes(1);

    retryHandler!({ message: mkMessage({ delivery_status: DeliveryStatus.FAILED }) });
    expect(spy).toHaveBeenCalledTimes(1); // FAILED rows are not deliverable until re-armed
  });

  describe('lease renewal (review round 5 fix #2 — no double-send on slow sends)', () => {
    const longText = `${'x'.repeat(2000)}\n${'y'.repeat(2000)}\n${'z'.repeat(2000)}`;

    it('renews the lease BEFORE every chunk send', async () => {
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({ id: 'm-long', content: longText, meta: { claim_token: 'tok-1' } }),
      );
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());

      await service.deliver(mkMessage({ id: 'm-long', content: longText }));

      // one renewal per chunk, all fenced by the claim token
      expect(messages.renewDeliveryClaim).toHaveBeenCalledTimes(3);
      expect(messages.renewDeliveryClaim).toHaveBeenNthCalledWith(1, 'm-long', 'tok-1');
      expect(messages.renewDeliveryClaim).toHaveBeenNthCalledWith(3, 'm-long', 'tok-1');
      expect(messages.markSent).toHaveBeenCalledWith('m-long', '77', 'tok-1');
    });

    it('renewal order is strictly renew → send → record for EVERY chunk', async () => {
      const order: string[] = [];
      messages.renewDeliveryClaim.mockImplementation(async () => {
        order.push('renew');
        return true;
      });
      gateway.sendMessage.mockImplementation(async () => {
        order.push('send');
        return { message_id: '77' };
      });
      messages.recordChunkSent.mockImplementation(async () => {
        order.push('record');
        return true;
      });
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({ id: 'm-long', content: longText, meta: { claim_token: 'tok-1' } }),
      );
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());

      await service.deliver(mkMessage({ id: 'm-long', content: longText }));

      expect(order).toEqual([
        'renew', 'send', 'record',
        'renew', 'send', 'record',
        'renew', 'send', 'record',
      ]);
    });

    it('LOSING the lease renewal aborts BEFORE sending the chunk — no zombie send', async () => {
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({ id: 'm-long', content: longText, meta: { claim_token: 'tok-zombie' } }),
      );
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());
      messages.renewDeliveryClaim
        .mockResolvedValueOnce(true) // chunk 1: renewal ok
        .mockResolvedValueOnce(false); // chunk 2: another worker re-claimed

      await service.deliver(mkMessage({ id: 'm-long', content: longText }));

      // chunk 1 was sent (renewal + fence ok), chunk 2 NEVER went out
      expect(gateway.sendMessage).toHaveBeenCalledTimes(1);
      expect(messages.markSent).not.toHaveBeenCalled();
      expect(messages.markFailed).not.toHaveBeenCalled(); // the new owner owns the outcome
    });
  });

  describe('multi-part resume (review fix — no duplicated chunks after a failure)', () => {
    const longText = `${'x'.repeat(2000)}\n${'y'.repeat(2000)}\n${'z'.repeat(2000)}`;
    // three 2000-char parts separated by newlines → 3 chunks (newline cuts)
    const chunks = () => splitForTelegram(longText);

    it('records durable progress after EVERY chunk and keeps the first chunk’s id', async () => {
      expect(chunks().length).toBe(3);
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({ id: 'm-long', content: longText, meta: { claim_token: 'tok-1' } }),
      );
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());
      gateway.sendMessage
        .mockResolvedValueOnce({ message_id: '77' })
        .mockResolvedValueOnce({ message_id: '78' })
        .mockResolvedValueOnce({ message_id: '79' });

      await service.deliver(mkMessage({ id: 'm-long', content: longText }));

      expect(gateway.sendMessage).toHaveBeenCalledTimes(3);
      expect(messages.recordChunkSent).toHaveBeenNthCalledWith(1, 'm-long', 1, '77', 'tok-1');
      expect(messages.recordChunkSent).toHaveBeenNthCalledWith(2, 'm-long', 2, '77', 'tok-1');
      expect(messages.recordChunkSent).toHaveBeenNthCalledWith(3, 'm-long', 3, '77', 'tok-1');
      expect(messages.markSent).toHaveBeenCalledWith('m-long', '77', 'tok-1'); // first chunk anchors the reply
    });

    it('chunk 2 fails → progress (1) is kept; the retry sends ONLY chunks 2 and 3', async () => {
      // FIRST attempt: chunk 1 delivered, chunk 2 throws
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({ id: 'm-long', content: longText, meta: { claim_token: 'tok-1' } }),
      );
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());
      gateway.sendMessage
        .mockResolvedValueOnce({ message_id: '77' })
        .mockRejectedValueOnce(new Error('network down'));

      await service.deliver(mkMessage({ id: 'm-long', content: longText }));

      expect(messages.recordChunkSent).toHaveBeenCalledWith('m-long', 1, '77', 'tok-1'); // progress persisted
      expect(messages.markFailed).toHaveBeenCalledWith(
        'm-long',
        'network down',
        'tok-1',
        expect.any(Date),
      );
      expect(messages.markSent).not.toHaveBeenCalled();

      // RETRY (sweeper): the claimed row carries meta.sent_chunks = 1 → resume
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({
          id: 'm-long',
          content: longText,
          meta: { sent_chunks: 1, first_telegram_message_id: '77', claim_token: 'tok-2' },
        }),
      );
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());
      gateway.sendMessage.mockClear();
      gateway.sendMessage
        .mockResolvedValueOnce({ message_id: '78' })
        .mockResolvedValueOnce({ message_id: '79' });

      await service.deliver(mkMessage({ id: 'm-long', content: longText }));

      // chunk 1 was NOT re-sent — exactly two sends, starting at chunk 2
      expect(gateway.sendMessage).toHaveBeenCalledTimes(2);
      expect(gateway.sendMessage).toHaveBeenNthCalledWith(1, { chat_id: '555', text: chunks()[1] });
      expect(gateway.sendMessage).toHaveBeenNthCalledWith(2, { chat_id: '555', text: chunks()[2] });
      expect(messages.recordChunkSent).toHaveBeenLastCalledWith('m-long', 3, '77', 'tok-2');
      expect(messages.markSent).toHaveBeenCalledWith('m-long', '77', 'tok-2'); // stored first id survives
    });

    it('every chunk already delivered but markSent crashed → finish bookkeeping WITHOUT any Telegram call', async () => {
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({
          id: 'm-long',
          content: longText,
          meta: { sent_chunks: 3, first_telegram_message_id: '77', claim_token: 'tok-1' },
        }),
      );
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());

      await service.deliver(mkMessage({ id: 'm-long', content: longText }));

      expect(gateway.sendMessage).not.toHaveBeenCalled(); // nothing re-sent
      expect(messages.markSent).toHaveBeenCalledWith('m-long', '77', 'tok-1');
    });

    it('FENCING (review fix): losing the claim mid-send ABORTS the remaining chunks', async () => {
      // our 60 s lease expires mid-send (slow multi-chunk delivery) and another
      // worker re-claims — our progress write matches 0 rows (false) → abort
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({ id: 'm-long', content: longText, meta: { claim_token: 'tok-zombie' } }),
      );
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());
      gateway.sendMessage.mockResolvedValue({ message_id: '77' });
      messages.recordChunkSent.mockResolvedValueOnce(true).mockResolvedValueOnce(false); // chunk 1 ok, chunk 2 → fence lost

      await service.deliver(mkMessage({ id: 'm-long', content: longText }));

      // chunk 1 + chunk 2 were sent, the fence broke AFTER chunk 2's progress
      // write → chunk 3 is NOT sent by us (the new owner owns the rest)
      expect(gateway.sendMessage).toHaveBeenCalledTimes(2);
      expect(messages.markSent).not.toHaveBeenCalled(); // we no longer own the terminal write
      expect(messages.markFailed).not.toHaveBeenCalled(); // and we don't clobber the new owner either
    });

    it('HONEST AT-LEAST-ONCE (documented residual window): a crash between a chunk’s Telegram send and its progress commit re-sends that chunk once on the retry', async () => {
      // attempt 1: chunk 1 DELIVERED to Telegram, then the process dies before
      // recordChunkSent can commit (simulated by the write throwing)
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({ id: 'm-long', content: longText, meta: { claim_token: 'tok-1' } }),
      );
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());
      gateway.sendMessage.mockResolvedValueOnce({ message_id: '77' });
      messages.recordChunkSent.mockRejectedValueOnce(new Error('hard crash'));

      await service.deliver(mkMessage({ id: 'm-long', content: longText }));

      expect(messages.markFailed).toHaveBeenCalledWith(
        'm-long',
        'hard crash',
        'tok-1',
        expect.any(Date),
      );

      // attempt 2 (sweeper): meta has NO sent_chunks (the crash lost it) → the
      // retry starts at chunk 1 again — chunk 1 reaches the user twice. That is
      // EXACTLY the documented at-least-once window; claiming less would be
      // dishonest (it is why progress is committed after EVERY chunk).
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({ id: 'm-long', content: longText, meta: { claim_token: 'tok-2' } }),
      );
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());
      gateway.sendMessage.mockClear();
      gateway.sendMessage
        .mockResolvedValueOnce({ message_id: '80' })
        .mockResolvedValueOnce({ message_id: '81' })
        .mockResolvedValueOnce({ message_id: '82' });

      await service.deliver(mkMessage({ id: 'm-long', content: longText }));

      expect(gateway.sendMessage).toHaveBeenCalledTimes(3); // all three chunks again
      expect(gateway.sendMessage).toHaveBeenNthCalledWith(1, { chat_id: '555', text: chunks()[0] }); // re-sent — documented
      expect(messages.markSent).toHaveBeenCalledWith('m-long', '80', 'tok-2');
    });
  });

  describe('splitForTelegram', () => {
    it('keeps short texts as a single chunk', () => {
      expect(splitForTelegram('سلام')).toEqual(['سلام']);
    });

    it('splits long texts on newlines first, all chunks under the limit', () => {
      const part = 'x'.repeat(2300);
      const text = `${part}\n${part}\n${part}`;
      const chunks = splitForTelegram(text);
      // newlines sit at 2300/4601 — both within the first 4000-char window, so
      // the text lands as three newline-aligned chunks
      expect(chunks.length).toBe(3);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4000);
      expect(chunks.join('')).toBe(text); // lossless: newlines are cut AT, not dropped
    });
  });

  describe('computeRetryBackoffMs (review round 5 — the schedule itself)', () => {
    it('grows exponentially: 20s → 40s → 80s → 160s for attempts 1..4 (no jitter)', () => {
      expect(OUTBOX_RETRY_BASE_MS).toBe(20_000);
      expect([1, 2, 3, 4].map((n) => computeRetryBackoffMs(n, 0.5))).toEqual([
        20_000, 40_000, 80_000, 160_000,
      ]);
    });

    it('applies ±20% jitter and never falls below 1 s', () => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        for (const rand of [0, 0.25, 0.5, 0.75, 0.999]) {
          const ms = OUTBOX_RETRY_BASE_MS * 2 ** (attempt - 1);
          const value = computeRetryBackoffMs(attempt, rand);
          const expected = Math.round(ms * (1 + (rand * 2 - 1) * 0.2));
          expect(value).toBe(Math.max(1_000, expected));
        }
      }
    });

    it('caps at OUTBOX_RETRY_MAX_MS (deep attempt counts stop growing)', () => {
      expect(OUTBOX_RETRY_MAX_MS).toBe(600_000);
      expect(computeRetryBackoffMs(50, 0.5)).toBe(OUTBOX_RETRY_MAX_MS);
      expect(computeRetryBackoffMs(50, 0)).toBe(OUTBOX_RETRY_MAX_MS * 0.8); // −20% jitter
    });

    it('a 2-minute Telegram outage can no longer exhaust the 5-attempt budget', () => {
      // the reviewer's scenario: with the old behavior the 15 s sweeper burned
      // all 5 attempts in ~1 minute. With backoff the scheduled retries of a
      // message failing on attempts 1..4 land ≥ 120 s after the first attempt
      // (worst case: minimum jitter on every step).
      const minDelays = [1, 2, 3, 4].map((n) => computeRetryBackoffMs(n, 0));
      const totalMin = minDelays.reduce((a, b) => a + b, 0);
      expect(totalMin).toBeGreaterThanOrEqual(120_000);
      expect(totalMin).toBe(16_000 + 32_000 + 64_000 + 128_000); // 240 s ≥ 2 min outage (all −20% jitter)
    });
  });
});
