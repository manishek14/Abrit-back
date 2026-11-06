import { FlowRouterService } from './flow-router.service';
import { UsersService } from '../users/users.service';
import { MessagesService } from '../messages/messages.service';
import { InboxService } from '../inbox/inbox.service';
import { RegistrationService } from './registration.service';
import { TicketFlowService } from './ticket-flow.service';
import { MyTicketsService } from './mytickets.service';
import { ChatbotService } from './chatbot.service';
import { CommandsService } from './commands.service';
import { ReplyProvider, REPLY_PROVIDER } from '../ai/reply-provider.interface';
import { TelegramGateway } from '../telegram/telegram-gateway.interface';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { REG_REQUIRED } from '../../common/bot-messages';
import { BTN_CHATBOT_EXIT, BTN_COMPLETE_PROFILE, profileGateKeyboard } from '../telegram/keyboards';

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

describe('FlowRouterService (request §8 — THE routing precedence)', () => {
  let service: FlowRouterService;
  let users: { upsertTelegramUser: jest.Mock; setBlocked: jest.Mock };
  let messages: { findByTelegramUpdateId: jest.Mock; addOutboundMessage: jest.Mock; findAssistantReply: jest.Mock };
  let inbox: { markDone: jest.Mock };
  let registration: { isComplete: jest.Mock; start: jest.Mock; handleText: jest.Mock; handleContact: jest.Mock };
  let ticketFlow: { handleText: jest.Mock; start: jest.Mock };
  let myTickets: { show: jest.Mock; handleCallback: jest.Mock; handleTicketReply: jest.Mock; handleViewAction: jest.Mock };
  let chatbot: { handleText: jest.Mock; runTurn: jest.Mock; enter: jest.Mock };
  let commands: { handle: jest.Mock };
  let replyProvider: { reply: jest.Mock };
  let gateway: { active: boolean; sendMessage: jest.Mock; answerCallbackQuery: jest.Mock };

  beforeEach(() => {
    users = {
      upsertTelegramUser: jest.fn().mockImplementation(async () => mkUser()),
      setBlocked: jest.fn(),
    };
    messages = {
      findByTelegramUpdateId: jest.fn().mockResolvedValue(null),
      addOutboundMessage: jest.fn(),
      findAssistantReply: jest.fn().mockResolvedValue(null),
    };
    inbox = { markDone: jest.fn().mockResolvedValue(undefined) };
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
    chatbot = {
      handleText: jest.fn().mockResolvedValue(false),
      runTurn: jest.fn().mockResolvedValue(undefined),
      enter: jest.fn().mockResolvedValue(undefined),
    };
    commands = { handle: jest.fn().mockResolvedValue(undefined) };
    replyProvider = { reply: jest.fn() };
    gateway = {
      active: true,
      sendMessage: jest.fn().mockResolvedValue({ message_id: '1' }),
      answerCallbackQuery: jest.fn(),
    };
    service = new FlowRouterService(
      users as unknown as UsersService,
      messages as unknown as MessagesService,
      inbox as unknown as InboxService,
      registration as unknown as RegistrationService,
      ticketFlow as unknown as TicketFlowService,
      myTickets as unknown as MyTicketsService,
      chatbot as unknown as ChatbotService,
      commands as unknown as CommandsService,
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

  it('callback from a GATED user → restriction + «تکمیل پروفایل» keyboard (§2, no auto-start)', async () => {
    registration.isComplete.mockReturnValue(false);
    await service.route(mkUpdate({ callback_query: { id: 'cb1', from: { id: 700100200 }, message: { chat: { id: 555, type: 'private' } }, data: 'myt:page:2' } }));
    expect(myTickets.handleCallback).not.toHaveBeenCalled();
    expect(gateway.answerCallbackQuery).toHaveBeenCalledWith('cb1');
    // §2: restriction message + gate keyboard — registration does NOT auto-start
    expect(gateway.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: REG_REQUIRED }));
    expect(registration.start).not.toHaveBeenCalled();
    expect(inbox.markDone).toHaveBeenCalledWith('9001');
  });

  it('commands take precedence over flows (e.g. /cancel inside a wizard)', async () => {
    await service.route(textUpdate('/cancel'));
    expect(commands.handle).toHaveBeenCalledWith(expect.anything(), '555', { name: 'cancel', raw: '/cancel' });
    expect(chatbot.runTurn).not.toHaveBeenCalled();
  });

  it('§4 HARD RULE: the wizard consumes the description — NEVER the AI handler', async () => {
    ticketFlow.handleText.mockResolvedValueOnce(true);
    await service.route(textUpdate('متن کامل درخواست تیکت من'));
    expect(ticketFlow.handleText).toHaveBeenCalledWith(expect.anything(), '555', 'متن کامل درخواست تیکت من', '9001');
    expect(chatbot.runTurn).not.toHaveBeenCalled(); // the bug's exact regression test
  });

  it('§4 HARD RULE: registration consumes text while REGISTER_* is active', async () => {
    registration.handleText.mockResolvedValueOnce(true);
    await service.route(textUpdate('علی رضایی'));
    expect(registration.handleText).toHaveBeenCalled();
    expect(chatbot.runTurn).not.toHaveBeenCalled();
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
    expect(chatbot.runTurn).not.toHaveBeenCalled();
  });

  it('§4/§7: chatbot mode consumes EVERY plain text — even menu-button labels go to the AI', async () => {
    chatbot.handleText.mockResolvedValue(true);
    await service.route(textUpdate('🎫 ثبت تیکت جدید'));
    expect(chatbot.handleText).toHaveBeenCalledWith(expect.anything(), '555', '🎫 ثبت تیکت جدید', '9001');
    expect(ticketFlow.start).not.toHaveBeenCalled(); // §4.5: never a ticket request in chat mode
    expect(chatbot.runTurn).not.toHaveBeenCalled();
  });

  it('menu buttons route to their actions (exact keyboard labels)', async () => {
    await service.route(textUpdate('🎫 ثبت تیکت جدید'));
    expect(ticketFlow.start).toHaveBeenCalled();
    expect(chatbot.runTurn).not.toHaveBeenCalled();

    jest.clearAllMocks();
    users.upsertTelegramUser.mockResolvedValue(mkUser());
    await service.route(textUpdate('📋 تیکت‌های من'));
    expect(myTickets.show).toHaveBeenCalledWith(expect.anything(), '555', 1);
  });

  it('default plain text from a REGISTERED user with no state → chatbot runTurn (NOT a ticket)', async () => {
    await service.route(textUpdate('سلام، چطور تیکت ثبت کنم؟'));
    expect(chatbot.runTurn).toHaveBeenCalledWith(expect.anything(), '555', 'سلام، چطور تیکت ثبت کنم؟', '9001');
    expect(ticketFlow.start).not.toHaveBeenCalled();
  });

  it('§2: a GATED user clicking a menu button gets the gate keyboard — the feature is NOT executed', async () => {
    registration.isComplete.mockReturnValue(false);
    await service.route(textUpdate('🎫 ثبت تیکت جدید'));
    expect(ticketFlow.start).not.toHaveBeenCalled();
    expect(registration.start).not.toHaveBeenCalled(); // no auto-start — the user opts in
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: REG_REQUIRED, reply_markup: profileGateKeyboard() }),
    );
    expect(chatbot.runTurn).not.toHaveBeenCalled();
  });

  it('§2: a GATED user cannot bypass with random text either', async () => {
    registration.isComplete.mockReturnValue(false);
    await service.route(textUpdate('یه پیام معمولی'));
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ reply_markup: profileGateKeyboard() }),
    );
    expect(chatbot.runTurn).not.toHaveBeenCalled();
  });

  it('§2: BTN_COMPLETE_PROFILE from a gated user starts registration DIRECTLY (no restriction prefix)', async () => {
    registration.isComplete.mockReturnValue(false);
    await service.route(textUpdate(BTN_COMPLETE_PROFILE));
    expect(registration.start).toHaveBeenCalledWith(expect.anything(), '555'); // no { gated: true }
    expect(gateway.sendMessage).not.toHaveBeenCalled();
  });

  it('§2: BTN_EDIT_PROFILE from a registered user re-runs registration (edit path)', async () => {
    await service.route(textUpdate('✏️ ویرایش اطلاعات'));
    expect(registration.start).toHaveBeenCalledWith(expect.anything(), '555');
  });

  it('§4: the stale chatbot exit button with no state lands on the main menu', async () => {
    await service.route(textUpdate(BTN_CHATBOT_EXIT));
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(chatbot.runTurn).not.toHaveBeenCalled();
  });

  it('dedup-first: an update whose message is already stored NEVER hits the AI chat', async () => {
    messages.findByTelegramUpdateId.mockResolvedValueOnce({ id: 'm-1', ticket_id: 't-1' });
    await service.route(textUpdate('متن تیکت قبلی'));
    expect(chatbot.runTurn).not.toHaveBeenCalled();
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

  it('a thrown chatbot error propagates (row stays PROCESSING for the sweeper — never dropped)', async () => {
    chatbot.runTurn.mockRejectedValueOnce(new Error('boom'));
    await expect(service.route(textUpdate('سلام'))).rejects.toThrow('boom');
    expect(inbox.markDone).not.toHaveBeenCalled();
  });

  it('blocked-flag recovery on a fresh message', async () => {
    users.upsertTelegramUser.mockResolvedValueOnce(mkUser({ is_blocked: true }));
    await service.route(textUpdate('سلام'));
    expect(users.setBlocked).toHaveBeenCalledWith('u-1', false);
  });
});
