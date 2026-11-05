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
