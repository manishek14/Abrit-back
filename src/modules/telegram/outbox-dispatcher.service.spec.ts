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
      recordChunkSent: jest.fn(),
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

  it('wins the claim → sends the (fresh) claimed row and marks it SENT', async () => {
    const claimed = mkMessage({ id: 'm-9', content: 'متن جدید' });
    messages.claimForDelivery.mockResolvedValueOnce(claimed);
    tickets.findById.mockResolvedValueOnce(mkTicket());
    users.findByIdOrNull.mockResolvedValueOnce(mkUser());

    await service.deliver(mkMessage({ id: 'm-stale' }));

    expect(messages.claimForDelivery).toHaveBeenCalledWith('m-stale');
    expect(gateway.sendMessage).toHaveBeenCalledWith({ chat_id: '555', text: 'متن جدید' });
    expect(messages.markSent).toHaveBeenCalledWith('m-9', '77');
  });

  it('403 from Telegram → block the user and never retry', async () => {
    messages.claimForDelivery.mockResolvedValueOnce(mkMessage());
    tickets.findById.mockResolvedValueOnce(mkTicket());
    users.findByIdOrNull.mockResolvedValueOnce(mkUser());
    gateway.sendMessage.mockRejectedValueOnce(new TelegramApiError('blocked', 403, false));

    await service.deliver(mkMessage());

    expect(users.setBlocked).toHaveBeenCalledWith('u-1', true);
    expect(messages.markPermanentlyFailed).toHaveBeenCalledWith('m-1', 'blocked');
    expect(messages.markSent).not.toHaveBeenCalled();
  });

  it('retryable error → markFailed (sweeper retries later)', async () => {
    messages.claimForDelivery.mockResolvedValueOnce(mkMessage());
    tickets.findById.mockResolvedValueOnce(mkTicket());
    users.findByIdOrNull.mockResolvedValueOnce(mkUser());
    gateway.sendMessage.mockRejectedValueOnce(new Error('network down'));

    await service.deliver(mkMessage());

    expect(messages.markFailed).toHaveBeenCalledWith('m-1', 'network down');
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
      messages.claimForDelivery.mockResolvedValueOnce(mkMessage({ id: 'm-long', content: longText }));
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());
      gateway.sendMessage
        .mockResolvedValueOnce({ message_id: '77' })
        .mockResolvedValueOnce({ message_id: '78' })
        .mockResolvedValueOnce({ message_id: '79' });

      await service.deliver(mkMessage({ id: 'm-long', content: longText }));

      expect(gateway.sendMessage).toHaveBeenCalledTimes(3);
      expect(messages.recordChunkSent).toHaveBeenNthCalledWith(1, 'm-long', 1, '77');
      expect(messages.recordChunkSent).toHaveBeenNthCalledWith(2, 'm-long', 2, '77');
      expect(messages.recordChunkSent).toHaveBeenNthCalledWith(3, 'm-long', 3, '77');
      expect(messages.markSent).toHaveBeenCalledWith('m-long', '77'); // first chunk anchors the reply
    });

    it('chunk 2 fails → progress (1) is kept; the retry sends ONLY chunks 2 and 3', async () => {
      // FIRST attempt: chunk 1 delivered, chunk 2 throws
      messages.claimForDelivery.mockResolvedValueOnce(mkMessage({ id: 'm-long', content: longText }));
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());
      gateway.sendMessage
        .mockResolvedValueOnce({ message_id: '77' })
        .mockRejectedValueOnce(new Error('network down'));

      await service.deliver(mkMessage({ id: 'm-long', content: longText }));

      expect(messages.recordChunkSent).toHaveBeenCalledWith('m-long', 1, '77'); // progress persisted
      expect(messages.markFailed).toHaveBeenCalledWith('m-long', 'network down');
      expect(messages.markSent).not.toHaveBeenCalled();

      // RETRY (sweeper): the claimed row carries meta.sent_chunks = 1 → resume
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({
          id: 'm-long',
          content: longText,
          meta: { sent_chunks: 1, first_telegram_message_id: '77' },
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
      expect(messages.recordChunkSent).toHaveBeenLastCalledWith('m-long', 3, '77');
      expect(messages.markSent).toHaveBeenCalledWith('m-long', '77'); // stored first id survives
    });

    it('every chunk already delivered but markSent crashed → finish bookkeeping WITHOUT any Telegram call', async () => {
      messages.claimForDelivery.mockResolvedValueOnce(
        mkMessage({
          id: 'm-long',
          content: longText,
          meta: { sent_chunks: 3, first_telegram_message_id: '77' },
        }),
      );
      tickets.findById.mockResolvedValueOnce(mkTicket());
      users.findByIdOrNull.mockResolvedValueOnce(mkUser());

      await service.deliver(mkMessage({ id: 'm-long', content: longText }));

      expect(gateway.sendMessage).not.toHaveBeenCalled(); // nothing re-sent
      expect(messages.markSent).toHaveBeenCalledWith('m-long', '77');
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
