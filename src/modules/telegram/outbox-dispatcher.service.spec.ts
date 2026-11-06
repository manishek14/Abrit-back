import { OutboxDispatcherService, splitForTelegram } from './outbox-dispatcher.service';
import { MessagesService } from '../messages/messages.service';
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
    markSent: jest.Mock;
    markFailed: jest.Mock;
    markPermanentlyFailed: jest.Mock;
    deferRetry: jest.Mock;
    recordChunkSent: jest.Mock;
  };
  let tickets: { findById: jest.Mock };
  let users: { findByIdOrNull: jest.Mock; setBlocked: jest.Mock };
  let events: { on: jest.Mock };
  let gateway: TelegramGateway & { sendMessage: jest.Mock };

  beforeEach(() => {
    messages = {
      claimForDelivery: jest.fn(),
      markSent: jest.fn(),
      markFailed: jest.fn(),
      markPermanentlyFailed: jest.fn(),
      deferRetry: jest.fn(),
      // the fenced progress write succeeds by default (review fix: the
      // dispatcher now checks ownership on every chunk)
      recordChunkSent: jest.fn().mockResolvedValue(true),
    };
    tickets = { findById: jest.fn() };
    users = { findByIdOrNull: jest.fn(), setBlocked: jest.fn() };
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

  it('403 from Telegram → block the user and never retry', async () => {
    messages.claimForDelivery.mockResolvedValueOnce(mkMessage({ meta: { claim_token: 'tok-1' } }));
    tickets.findById.mockResolvedValueOnce(mkTicket());
    users.findByIdOrNull.mockResolvedValueOnce(mkUser());
    gateway.sendMessage.mockRejectedValueOnce(new TelegramApiError('blocked', 403, false));

    await service.deliver(mkMessage());

    expect(users.setBlocked).toHaveBeenCalledWith('u-1', true);
    expect(messages.markPermanentlyFailed).toHaveBeenCalledWith('m-1', 'blocked', 'tok-1');
    expect(messages.markSent).not.toHaveBeenCalled();
  });

  it('retryable error → markFailed (sweeper retries later)', async () => {
    messages.claimForDelivery.mockResolvedValueOnce(mkMessage({ meta: { claim_token: 'tok-1' } }));
    tickets.findById.mockResolvedValueOnce(mkTicket());
    users.findByIdOrNull.mockResolvedValueOnce(mkUser());
    gateway.sendMessage.mockRejectedValueOnce(new Error('network down'));

    await service.deliver(mkMessage());

    expect(messages.markFailed).toHaveBeenCalledWith('m-1', 'network down', 'tok-1');
  });

  it('onModuleInit: only outbound PENDING messages are picked from message.created', () => {
    service.onModuleInit();
    expect(events.on).toHaveBeenCalledWith('message.created', expect.any(Function));

    const handler = events.on.mock.calls[0][1] as (p: { message: Message }) => void;
    const spy = jest.spyOn(service, 'deliver').mockImplementation(async () => undefined);

    handler({ message: mkMessage() }); // ASSISTANT + PENDING → deliver
    handler({ message: mkMessage({ role: MessageRole.USER, delivery_status: null }) }); // user → skip
    handler({ message: mkMessage({ delivery_status: DeliveryStatus.SENT }) }); // already sent → skip

    expect(spy).toHaveBeenCalledTimes(1);
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
      expect(messages.markFailed).toHaveBeenCalledWith('m-long', 'network down', 'tok-1');
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

      expect(messages.markFailed).toHaveBeenCalledWith('m-long', 'hard crash', 'tok-1');

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
});
