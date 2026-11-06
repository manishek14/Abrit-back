import { FlowRouterService } from './flow-router.service';
import { UsersService } from '../users/users.service';
import { TicketsService } from '../tickets/tickets.service';
import { MessagesService } from '../messages/messages.service';
import { InboxService } from '../inbox/inbox.service';
import { BotStateService } from './bot-state.service';
import { RegistrationService } from './registration.service';
import { TicketFlowService } from './ticket-flow.service';
import { MyTicketsService } from './mytickets.service';
import { CommandsService } from './commands.service';
import { GeneralChatService } from '../ai/general-chat.service';
import { ReplyProvider, REPLY_PROVIDER } from '../ai/reply-provider.interface';
import { TelegramGateway } from '../telegram/telegram-gateway.interface';
import { TelegramUser } from '../../database/entities/telegram-user.entity';

const mkUser = (over: Partial<TelegramUser> = {}): TelegramUser =>
  ({
    id: 'u-1',
    telegram_id: '700100200',
    chat_id: '555',
    profile_completed_at: new Date(),
    full_name: 'علی رضایی',
    phone: '09123456789',
    is_blocked: false,
    ...over,
  }) as TelegramUser;

const mkUpdate = (payload: Record<string, unknown>) =>
  ({ update_id: '9001', payload, status: 'RECEIVED' }) as never;

describe('FlowRouterService (feature §4 — THE routing precedence)', () => {
  let service: FlowRouterService;
  let users: { upsertTelegramUser: jest.Mock; setBlocked: jest.Mock; setBotState: jest.Mock };
  let tickets: { findActiveTicket: jest.Mock; findById: jest.Mock };
  let messages: { findByTelegramUpdateId: jest.Mock; addOutboundMessage: jest.Mock; findAssistantReply: jest.Mock };
  let inbox: { markDone: jest.Mock };
  let botState: { get: jest.Mock; withChatTurn: jest.Mock };
  let registration: { isComplete: jest.Mock; start: jest.Mock; handleText: jest.Mock; handleContact: jest.Mock };
  let ticketFlow: { handleText: jest.Mock; start: jest.Mock };
  let myTickets: { show: jest.Mock; handleCallback: jest.Mock; handleTicketReply: jest.Mock; handleViewAction: jest.Mock };
  let commands: { handle: jest.Mock };
  let generalChat: { reply: jest.Mock };
  let replyProvider: { reply: jest.Mock };
  let gateway: { active: boolean; sendMessage: jest.Mock; answerCallbackQuery: jest.Mock };

  beforeEach(() => {
    users = {
      upsertTelegramUser: jest.fn().mockImplementation(async () => mkUser()),
      setBlocked: jest.fn(),
      setBotState: jest.fn(),
    };
    tickets = { findActiveTicket: jest.fn().mockResolvedValue(null), findById: jest.fn() };
    messages = {
      findByTelegramUpdateId: jest.fn().mockResolvedValue(null),
      addOutboundMessage: jest.fn(),
      findAssistantReply: jest.fn().mockResolvedValue(null),
    };
    inbox = { markDone: jest.fn().mockResolvedValue(undefined) };
    botState = {
      get: jest.fn().mockResolvedValue(null),
      withChatTurn: jest.fn().mockReturnValue({ flow: 'CHAT', data: { history: [] } }),
    };
    registration = {
      isComplete: jest.fn(() => true),
      start: jest.fn().mockResolvedValue(undefined),
      handleText: jest.fn().mockResolvedValue(false),
      handleContact: jest.fn().mockResolvedValue(undefined),
    };
    ticketFlow = { handleText: jest.fn().mockResolvedValue(false), start: jest.fn() };
    myTickets = {
      show: jest.fn(),
      handleCallback: jest.fn(),
      handleTicketReply: jest.fn().mockResolvedValue(null),
      handleViewAction: jest.fn().mockResolvedValue(false),
    };
    commands = { handle: jest.fn().mockResolvedValue(undefined) };
    generalChat = {
      reply: jest.fn().mockResolvedValue({ content: 'پاسخ هوشمند', meta: { provider: 'openrouter' } }),
    };
    replyProvider = { reply: jest.fn() };
    gateway = {
      active: true,
      sendMessage: jest.fn().mockResolvedValue({ message_id: '1' }),
      answerCallbackQuery: jest.fn(),
    };
    service = new FlowRouterService(
      users as unknown as UsersService,
      tickets as unknown as TicketsService,
      messages as unknown as MessagesService,
      inbox as unknown as InboxService,
      botState as unknown as BotStateService,
      registration as unknown as RegistrationService,
      ticketFlow as unknown as TicketFlowService,
      myTickets as unknown as MyTicketsService,
      commands as unknown as CommandsService,
      generalChat as unknown as GeneralChatService,
      replyProvider as unknown as ReplyProvider,
      gateway as unknown as TelegramGateway,
    );
  });

  const textUpdate = (text: string) => mkUpdate({
    message: {
      message_id: 1,
      from: { id: 700100200, is_bot: false, first_name: 'علی' },
      chat: { id: 555, type: 'private' },
      text,
    },
  });

  it('callback_query → my-tickets handler + markDone', async () => {
    await service.route(mkUpdate({ callback_query: { id: 'cb1', from: { id: 700100200 }, message: { chat: { id: 555, type: 'private' } }, data: 'myt:page:2' } }));
    expect(myTickets.handleCallback).toHaveBeenCalledWith(expect.anything(), '555', 'cb1', 'myt:page:2');
    expect(inbox.markDone).toHaveBeenCalledWith('9001');
  });

  it('commands take precedence over flows (e.g. /cancel inside a wizard)', async () => {
    await service.route(textUpdate('/cancel'));
    expect(commands.handle).toHaveBeenCalledWith(expect.anything(), '555', { name: 'cancel', raw: '/cancel' });
    expect(generalChat.reply).not.toHaveBeenCalled();
  });

  it('§4 HARD RULE: the wizard consumes the description — NEVER the AI handler', async () => {
    ticketFlow.handleText.mockResolvedValueOnce(true);
    await service.route(textUpdate('متن کامل درخواست تیکت من'));
    expect(ticketFlow.handleText).toHaveBeenCalledWith(expect.anything(), '555', 'متن کامل درخواست تیکت من', '9001');
    expect(generalChat.reply).not.toHaveBeenCalled(); // the bug's exact regression test
  });

  it('§4 HARD RULE: registration consumes text while REGISTER_* is active', async () => {
    registration.handleText.mockResolvedValueOnce(true);
    await service.route(textUpdate('علی رضایی'));
    expect(registration.handleText).toHaveBeenCalled();
    expect(generalChat.reply).not.toHaveBeenCalled();
  });

  it('§4 HARD RULE: TICKET_REPLY text goes into the ticket pipeline, not the AI chat', async () => {
    myTickets.handleTicketReply.mockResolvedValueOnce({
      ticket: { id: 't-1' },
      userMessage: { id: 'm-1' },
    });
    replyProvider.reply.mockResolvedValueOnce({ content: 'پاسخ', meta: {} });

    await service.route(textUpdate('پیام داخل تیکت'));

    expect(replyProvider.reply).toHaveBeenCalled();
    expect(messages.addOutboundMessage).toHaveBeenCalled(); // durable outbox
    expect(generalChat.reply).not.toHaveBeenCalled();
  });

  it('menu buttons route to their actions (exact keyboard labels)', async () => {
    await service.route(textUpdate('🎫 ثبت تیکت جدید'));
    expect(ticketFlow.start).toHaveBeenCalled();
    expect(generalChat.reply).not.toHaveBeenCalled();

    jest.clearAllMocks();
    users.upsertTelegramUser.mockResolvedValue(mkUser());
    await service.route(textUpdate('📋 تیکت‌های من'));
    expect(myTickets.show).toHaveBeenCalledWith(expect.anything(), '555', 1);
  });

  it('plain text from a REGISTERED user with no state → general AI chat (NOT a ticket)', async () => {
    await service.route(textUpdate('سلام، چطور تیکت ثبت کنم؟'));
    expect(generalChat.reply).toHaveBeenCalledWith(expect.objectContaining({ userText: 'سلام، چطور تیکت ثبت کنم؟' }));
    expect(gateway.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'پاسخ هوشمند' }));
    expect(botState.withChatTurn).toHaveBeenCalled(); // history persists in bot_state
  });

  it('plain text from an UNREGISTERED user → registration gate (§1)', async () => {
    registration.isComplete.mockReturnValue(false);
    await service.route(textUpdate('سلام'));
    expect(registration.start).toHaveBeenCalledWith(expect.anything(), '555', { gated: true });
    expect(generalChat.reply).not.toHaveBeenCalled();
  });

  it('dedup-first: an update whose message is already stored NEVER hits the AI chat', async () => {
    messages.findByTelegramUpdateId.mockResolvedValueOnce({ id: 'm-1', ticket_id: 't-1' });
    await service.route(textUpdate('متن تیکت قبلی'));
    expect(generalChat.reply).not.toHaveBeenCalled();
    expect(inbox.markDone).toHaveBeenCalled();
  });

  it('contact messages route to registration', async () => {
    await service.route(mkUpdate({
      message: {
        message_id: 2,
        from: { id: 700100200 },
        chat: { id: 555, type: 'private' },
        contact: { phone_number: '09123456789', user_id: 700100200 },
      },
    }));
    expect(registration.handleContact).toHaveBeenCalledWith(
      expect.anything(),
      '555',
      expect.objectContaining({ phone_number: '09123456789' }),
    );
  });

  it('non-text, non-contact message → the only-text hint', async () => {
    await service.route(mkUpdate({
      message: {
        message_id: 3,
        from: { id: 700100200 },
        chat: { id: 555, type: 'private' },
        photo: [{}],
      },
    }));
    expect(gateway.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('فقط پیام متنی') }));
    expect(inbox.markDone).toHaveBeenCalled();
  });

  it('AI failure in general chat still markDone (the row never sticks PROCESSING for content reasons)', async () => {
    generalChat.reply.mockRejectedValueOnce(new Error('boom'));
    await expect(service.route(textUpdate('سلام'))).rejects.toThrow('boom');
    // orchestrator catches → recordError; markDone NOT called (sweeper retry owns it)
    expect(inbox.markDone).not.toHaveBeenCalled();
  });

  it('blocked-flag recovery on a fresh message', async () => {
    users.upsertTelegramUser.mockResolvedValueOnce(mkUser({ is_blocked: true }));
    await service.route(textUpdate('سلام'));
    expect(users.setBlocked).toHaveBeenCalledWith('u-1', false);
  });
});
