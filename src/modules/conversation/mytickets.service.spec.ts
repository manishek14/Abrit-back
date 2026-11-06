import { MyTicketsService } from './mytickets.service';
import { TicketsService } from '../tickets/tickets.service';
import { MessagesService } from '../messages/messages.service';
import { BotStateService } from './bot-state.service';
import { TelegramGateway } from '../telegram/telegram-gateway.interface';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { Ticket } from '../../database/entities/ticket.entity';
import { TicketDepartment, TicketStatus } from '../../database/enums';
import { stateWith } from './bot-state.test-util';

const mkUser = (over: Partial<TelegramUser> = {}): TelegramUser =>
  ({ id: 'u-1', telegram_id: '700100200', chat_id: '700100200', ...over }) as TelegramUser;
const mkTicket = (over: Partial<Ticket> = {}): Ticket =>
  ({
    id: 't-1',
    ticket_number: 'TKT-10001',
    user_id: 'u-1',
    status: TicketStatus.OPEN,
    subject: 'مشکل در ورود به حساب',
    department: TicketDepartment.TECHNICAL,
    created_at: new Date('2026-11-06T11:30:00Z'),
    ...over,
  }) as Ticket;

describe('MyTicketsService (feature §2 — تیکت‌های من)', () => {
  let service: MyTicketsService;
  let tickets: { listUserTickets: jest.Mock; findById: jest.Mock };
  let messages: { findByTelegramUpdateId: jest.Mock; addUserMessage: jest.Mock };
  let botState: { get: jest.Mock; set: jest.Mock; clear: jest.Mock };
  let gateway: { active: boolean; sendMessage: jest.Mock; answerCallbackQuery: jest.Mock };

  beforeEach(() => {
    tickets = {
      listUserTickets: jest.fn().mockResolvedValue({
        data: [mkTicket()],
        meta: { page: 1, limit: 5, total: 1 },
      }),
      findById: jest.fn(),
    };
    messages = {
      findByTelegramUpdateId: jest.fn().mockResolvedValue(null),
      addUserMessage: jest.fn().mockResolvedValue({ id: 'm-1', id_reply: null }),
    };
    botState = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
      clear: jest.fn(),
    };
    gateway = {
      active: true,
      sendMessage: jest.fn().mockResolvedValue({ message_id: '1' }),
      answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
    };
    service = new MyTicketsService(
      tickets as unknown as TicketsService,
      messages as unknown as MessagesService,
      botState as unknown as BotStateService,
      gateway as unknown as TelegramGateway,
    );
  });

  it('show renders the list with number/title/department/status + inline buttons', async () => {
    await service.show(mkUser(), '555', 1);

    const call = gateway.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('🎫 تیکت‌های شما');
    expect(call.text).toContain('مشکل در ورود به حساب');
    expect(call.text).toContain('⚙️ فنی');
    expect(call.text).toContain('باز'); // status label from the REAL enum
    expect(call.reply_markup).toBeDefined();
    const kb = call.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    expect(kb.inline_keyboard[0][0].callback_data).toBe('myt:view:t-1');
  });

  it('empty list → the "no tickets" message + main menu, state cleared', async () => {
    tickets.listUserTickets.mockResolvedValueOnce({ data: [], meta: { page: 1, limit: 5, total: 0 } });
    await service.show(mkUser(), '555', 1);
    const call = gateway.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('تیکتی ثبت نکرده‌اید');
    expect(botState.clear).toHaveBeenCalledWith('u-1');
  });

  it('pagination passes the requested page through', async () => {
    await service.show(mkUser(), '555', 2);
    expect(tickets.listUserTickets).toHaveBeenCalledWith('u-1', 2, 5);
  });

  it('callback page navigation re-renders the list', async () => {
    await service.handleCallback(mkUser(), '555', 'cb-1', 'myt:page:3');
    expect(gateway.answerCallbackQuery).toHaveBeenCalledWith('cb-1');
    expect(tickets.listUserTickets).toHaveBeenCalledWith('u-1', 3, 5);
  });

  it('callback view opens the ticket detail (Jalali date inside)', async () => {
    tickets.findById.mockResolvedValueOnce(mkTicket());
    await service.handleCallback(mkUser(), '555', 'cb-2', `myt:view:${'t-1'}`);
    const call = gateway.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('TKT-10001');
    expect(call.text).toContain('۱۴۰۵/۰۸/۱۵');
    expect(botState.set).toHaveBeenCalledWith('u-1', 'TICKET_VIEW', { ticketId: 't-1' });
  });

  it('§8 OWNERSHIP: a foreign ticket id is indistinguishable from a missing one', async () => {
    tickets.findById.mockResolvedValueOnce(mkTicket({ user_id: 'someone-else' }));
    await service.handleCallback(mkUser(), '555', 'cb-3', 'myt:view:t-1');
    const call = gateway.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('دسترسی ندارید'); // NOT the ticket data
    expect(call.text).not.toContain('TKT-10001');
    expect(botState.clear).toHaveBeenCalledWith('u-1');
  });

  it('💬 ارسال پیام in TICKET_VIEW → TICKET_REPLY for an ACTIVE ticket', async () => {
    tickets.findById.mockResolvedValue(mkTicket());
    botState.get.mockResolvedValue(stateWith('TICKET_VIEW', { ticketId: 't-1' }));

    const handled = await service.handleViewAction(mkUser(), '555', '💬 ارسال پیام');

    expect(handled).toBe(true);
    expect(botState.set).toHaveBeenCalledWith('u-1', 'TICKET_REPLY', { ticketId: 't-1' });
    expect(gateway.sendMessage.mock.calls.at(-1)![0].text).toContain('پیام خود را ارسال کنید');
  });

  it('💬 ارسال پیام on a CLOSED ticket is refused with the main menu', async () => {
    tickets.findById.mockResolvedValue(mkTicket({ status: TicketStatus.CLOSED }));
    botState.get.mockResolvedValue(stateWith('TICKET_VIEW', { ticketId: 't-1' }));

    await service.handleViewAction(mkUser(), '555', '💬 ارسال پیام');

    expect(botState.set).not.toHaveBeenCalledWith('u-1', 'TICKET_REPLY', expect.anything());
    expect(gateway.sendMessage.mock.calls.at(-1)![0].text).toContain('بسته شده است');
  });

  it('handleTicketReply stores the message INTO the user ticket (idempotent by update)', async () => {
    tickets.findById.mockResolvedValue(mkTicket());
    botState.get.mockResolvedValue(stateWith('TICKET_REPLY', { ticketId: 't-1' }));

    const out = await service.handleTicketReply(mkUser(), '555', 'پیام جدید کاربر', '9100');

    expect(out).not.toBeNull();
    expect(messages.addUserMessage).toHaveBeenCalledWith({
      ticket_id: 't-1',
      content: 'پیام جدید کاربر',
      telegram_update_id: '9100',
    });
  });

  it('handleTicketReply reuses an already-stored row on a re-run (resume, no duplicate)', async () => {
    tickets.findById.mockResolvedValue(mkTicket());
    messages.findByTelegramUpdateId.mockResolvedValueOnce({ id: 'm-77', ticket_id: 't-1', content: 'old' });
    botState.get.mockResolvedValue(stateWith('TICKET_REPLY', { ticketId: 't-1' }));

    const out = await service.handleTicketReply(mkUser(), '555', 'پیام جدید کاربر', '9100');

    expect(messages.addUserMessage).not.toHaveBeenCalled();
    expect(out?.userMessage.id).toBe('m-77');
  });

  it('§8: handleTicketReply with a foreign ticketId stores NOTHING', async () => {
    tickets.findById.mockResolvedValue(mkTicket({ user_id: 'other' }));
    botState.get.mockResolvedValue(stateWith('TICKET_REPLY', { ticketId: 't-1' }));

    const out = await service.handleTicketReply(mkUser(), '555', 'هک', '9101');

    expect(out).toBeNull();
    expect(messages.addUserMessage).not.toHaveBeenCalled();
  });

  it('handleTicketReply returns null without TICKET_REPLY state (router falls through)', async () => {
    botState.get.mockResolvedValue(null);
    expect(await service.handleTicketReply(mkUser(), '555', 'متن', '9102')).toBeNull();
    expect(messages.addUserMessage).not.toHaveBeenCalled();
  });
});
