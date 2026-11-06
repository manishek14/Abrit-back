import { ConflictException } from '@nestjs/common';
import { OrchestratorService } from './orchestrator.service';
import { InboxService } from '../inbox/inbox.service';
import { UsersService } from '../users/users.service';
import { TicketsService } from '../tickets/tickets.service';
import { MessagesService } from '../messages/messages.service';
import { CommandsService } from './commands.service';
import { ReplyProvider } from '../ai/reply-provider.interface';
import { TelegramGateway } from '../telegram/telegram-gateway.interface';
import { BotUpdate } from '../../database/entities/bot-update.entity';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { Ticket } from '../../database/entities/ticket.entity';
import { Message } from '../../database/entities/message.entity';
import { BotUpdateStage, BotUpdateStatus, MessageRole, TicketStatus } from '../../database/enums';

const rawUpdate = (messageOver: Record<string, unknown> = {}): Record<string, unknown> => ({
  update_id: 100,
  message: {
    message_id: 1,
    text: 'سلام، مشکل دارم',
    chat: { id: 555, type: 'private' },
    from: { id: 111, is_bot: false, username: 'sara', first_name: 'سارا' },
    ...messageOver,
  },
});

/** claim() is the source of truth for the payload under test. */
const mkUpdate = (payload: Record<string, unknown>): BotUpdate =>
  ({
    update_id: '100',
    payload,
    status: BotUpdateStatus.PROCESSING,
    attempts: 1,
  }) as BotUpdate;

const mkUser = (over: Partial<TelegramUser> = {}): TelegramUser =>
  ({ id: 'u-1', telegram_id: '111', chat_id: '555', is_blocked: false, ...over }) as TelegramUser;

const mkTicket = (over: Partial<Ticket> = {}): Ticket =>
  ({ id: 't-1', ticket_number: 'TKT-10001', user_id: 'u-1', ...over }) as Ticket;

const mkMessage = (over: Partial<Message> = {}): Message =>
  ({ id: 'm-1', ticket_id: 't-1', ...over }) as Message;

describe('OrchestratorService', () => {
  let service: OrchestratorService;
  let inbox: {
    claim: jest.Mock;
    markDone: jest.Mock;
    setStage: jest.Mock;
    recordError: jest.Mock;
    hasEarlierUnfinished: jest.Mock;
  };
  let users: { upsertTelegramUser: jest.Mock; setBlocked: jest.Mock };
  let tickets: { ensureActiveTicket: jest.Mock; findById: jest.Mock };
  let messages: {
    addUserMessage: jest.Mock;
    addOutboundMessage: jest.Mock;
    findAssistantReply: jest.Mock;
    findByTelegramUpdateId: jest.Mock;
  };
  let commands: { handle: jest.Mock };
  let replyProvider: { reply: jest.Mock };
  let gateway: { active: boolean; sendMessage: jest.Mock };

  /** Enqueue the given payload: claim returns it, so the test drives exactly this shape. */
  const process = (payload: Record<string, unknown>) => {
    inbox.claim.mockResolvedValueOnce(mkUpdate(payload));
    return service.enqueue(mkUpdate(payload));
  };

  beforeEach(() => {
    inbox = {
      claim: jest.fn(),
      markDone: jest.fn(),
      setStage: jest.fn(),
      recordError: jest.fn(),
      hasEarlierUnfinished: jest.fn().mockResolvedValue(false),
    };
    users = { upsertTelegramUser: jest.fn(), setBlocked: jest.fn() };
    tickets = { ensureActiveTicket: jest.fn(), findById: jest.fn() };
    messages = {
      addUserMessage: jest.fn(),
      addOutboundMessage: jest.fn(),
      findAssistantReply: jest.fn(),
      findByTelegramUpdateId: jest.fn().mockResolvedValue(null),
    };
    commands = { handle: jest.fn() };
    replyProvider = { reply: jest.fn() };
    gateway = { active: true, sendMessage: jest.fn().mockResolvedValue({ message_id: '1' }) };

    users.upsertTelegramUser.mockResolvedValue(mkUser());
    tickets.ensureActiveTicket.mockResolvedValue({
      ticket: mkTicket(),
      created: true,
      announcement: mkMessage({ id: 'm-announce', role: MessageRole.SYSTEM }),
    });
    messages.addUserMessage.mockResolvedValue(mkMessage());
    messages.addOutboundMessage.mockResolvedValue(mkMessage());
    messages.findAssistantReply.mockResolvedValue(null);
    replyProvider.reply.mockResolvedValue({ content: 'پاسخ دستیار', meta: null });

    service = new OrchestratorService(
      inbox as unknown as InboxService,
      users as unknown as UsersService,
      tickets as unknown as TicketsService,
      messages as unknown as MessagesService,
      commands as unknown as CommandsService,
      replyProvider as unknown as ReplyProvider,
      gateway as unknown as TelegramGateway,
    );
  });

  it('skips an update already claimed by another worker', async () => {
    inbox.claim.mockResolvedValueOnce(null);
    await service.enqueue(mkUpdate(rawUpdate()));
    expect(inbox.claim).toHaveBeenCalledWith('100');
    expect(inbox.markDone).not.toHaveBeenCalled();
    expect(users.upsertTelegramUser).not.toHaveBeenCalled();
  });

  it('marks updates without a message payload as done (edited/unsupported)', async () => {
    await process({ update_id: 100, edited_message: { text: 'x' } });
    expect(inbox.markDone).toHaveBeenCalledWith('100');
    expect(users.upsertTelegramUser).not.toHaveBeenCalled();
  });

  it('ignores non-private chats (groups/channels)', async () => {
    await process(rawUpdate({ chat: { id: -1, type: 'group' } }));
    expect(inbox.markDone).toHaveBeenCalledWith('100');
    expect(users.upsertTelegramUser).not.toHaveBeenCalled();
  });

  it('ignores bot senders', async () => {
    await process(rawUpdate({ from: { id: 999, is_bot: true } }));
    expect(inbox.markDone).toHaveBeenCalledWith('100');
    expect(users.upsertTelegramUser).not.toHaveBeenCalled();
  });

  describe('ORDERING GATE (review fix — order holds even after a failure)', () => {
    it('does NOT claim an update while an earlier update of the same chat is unfinished', async () => {
      inbox.hasEarlierUnfinished.mockResolvedValueOnce(true);
      await service.enqueue(mkUpdate(rawUpdate()));

      // the row stays RECEIVED — no attempt consumed, nothing processed;
      // the sweeper re-drives it once the blocker reaches DONE/FAILED.
      expect(inbox.claim).not.toHaveBeenCalled();
      expect(users.upsertTelegramUser).not.toHaveBeenCalled();
      expect(inbox.markDone).not.toHaveBeenCalled();
      expect(tickets.ensureActiveTicket).not.toHaveBeenCalled();
    });

    it('checks the gate with the chat id and the update id', async () => {
      inbox.hasEarlierUnfinished.mockResolvedValueOnce(true);
      await service.enqueue(mkUpdate(rawUpdate()));
      expect(inbox.hasEarlierUnfinished).toHaveBeenCalledWith('555', '100');
    });

    it('unsupported shapes skip the gate entirely (they never produce chat content)', async () => {
      await process(rawUpdate({ chat: { id: -1, type: 'group' } }));
      expect(inbox.hasEarlierUnfinished).not.toHaveBeenCalled();
      expect(inbox.markDone).toHaveBeenCalledWith('100');
    });
  });

  describe('blocked-state recovery (review fix — a stale is_blocked flag heals)', () => {
    it('clears the stale blocked flag and PROCESSES the fresh message', async () => {
      users.upsertTelegramUser.mockResolvedValueOnce(mkUser({ is_blocked: true }));

      await process(rawUpdate());

      // the flag is cleared — receiving a fresh, valid update proves the user
      // unblocked the bot (Telegram does not deliver from a blocking chat)
      expect(users.setBlocked).toHaveBeenCalledWith('u-1', false);
      expect(tickets.ensureActiveTicket).toHaveBeenCalled();
      expect(messages.addUserMessage).toHaveBeenCalled();
      expect(inbox.markDone).toHaveBeenCalledWith('100');
    });

    it('a user who is NOT blocked is never re-flagged', async () => {
      await process(rawUpdate());
      expect(users.setBlocked).not.toHaveBeenCalled();
    });
  });

  it('answers non-text messages with the "only text" notice', async () => {
    await process(rawUpdate({ text: undefined }));
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: '555', text: expect.stringContaining('فقط پیام متنی') }),
    );
    expect(inbox.markDone).toHaveBeenCalledWith('100');
    expect(tickets.ensureActiveTicket).not.toHaveBeenCalled();
  });

  it('rejects texts over 3000 characters without storing them', async () => {
    await process(rawUpdate({ text: 'a'.repeat(3001) }));
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('طولانی') }),
    );
    expect(inbox.markDone).toHaveBeenCalledWith('100');
    expect(messages.addUserMessage).not.toHaveBeenCalled();
  });

  it('routes commands to the command service', async () => {
    await process(rawUpdate({ text: '/start' }));
    expect(commands.handle).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u-1' }),
      '555',
      expect.objectContaining({ name: 'start' }),
    );
    expect(tickets.ensureActiveTicket).not.toHaveBeenCalled();
    expect(inbox.markDone).toHaveBeenCalledWith('100');
  });

  it('runs the full ticket flow: create ticket → store user msg → reply → outbox', async () => {
    await process(rawUpdate());

    expect(tickets.ensureActiveTicket).toHaveBeenCalledWith(
      'u-1',
      'سلام، مشکل دارم',
      expect.objectContaining({ announce: expect.any(Function) }), // the announcement builder — the SYSTEM message is stored INSIDE the creation transaction (review fix)
    );
    expect(messages.addUserMessage).toHaveBeenCalledWith({
      ticket_id: 't-1',
      content: 'سلام، مشکل دارم',
      telegram_update_id: '100',
    });
    expect(replyProvider.reply).toHaveBeenCalledTimes(1);
    // the orchestrator no longer stores the announcement itself — only the reply
    const calls = messages.addOutboundMessage.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({
      role: MessageRole.ASSISTANT,
      in_reply_to_id: 'm-1',
      content: 'پاسخ دستیار',
    });
    expect(inbox.markDone).toHaveBeenCalledWith('100');
  });

  it('records the processing milestones on the inbox row (stage tracking)', async () => {
    await process(rawUpdate());
    expect(inbox.setStage).toHaveBeenNthCalledWith(1, '100', BotUpdateStage.USER_SAVED);
    expect(inbox.setStage).toHaveBeenNthCalledWith(2, '100', BotUpdateStage.REPLY_SAVED);
  });

  it('checks for a previously stored message BEFORE creating any ticket (dedup-first)', async () => {
    await process(rawUpdate());
    expect(messages.findByTelegramUpdateId).toHaveBeenCalledWith('100');
  });

  describe('DEDUP-FIRST (review fix — a retry can never leave an EMPTY active ticket)', () => {
    it('a stored user message pins the retry to its ORIGINAL ticket; ensureActiveTicket is never called', async () => {
      // simulate the crash-retry of update 100: its message lives in a ticket
      // that an operator has since CLOSED
      const stored = mkMessage({ id: 'm-existing', ticket_id: 't-original' });
      messages.findByTelegramUpdateId.mockResolvedValueOnce(stored);
      tickets.findById.mockResolvedValueOnce(mkTicket({ id: 't-original', status: TicketStatus.CLOSED }));
      messages.addUserMessage.mockResolvedValueOnce(stored);

      await process(rawUpdate());

      expect(tickets.ensureActiveTicket).not.toHaveBeenCalled(); // no fresh empty ticket
      expect(messages.addUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({ ticket_id: 't-original' }),
      );
      expect(messages.addOutboundMessage).toHaveBeenCalledWith(
        expect.objectContaining({ ticket_id: 't-original' }), // the reply lands where the message lives
      );
      expect(inbox.markDone).toHaveBeenCalledWith('100');
    });

    it('a stored message whose ticket vanished is an error, not a silent drop', async () => {
      messages.findByTelegramUpdateId.mockResolvedValueOnce(
        mkMessage({ id: 'm-existing', ticket_id: 't-gone' }),
      );
      tickets.findById.mockResolvedValueOnce(null);

      await process(rawUpdate()); // processSafely swallows the throw

      expect(inbox.recordError).toHaveBeenCalledWith(
        '100',
        expect.stringContaining('t-gone'),
      );
      expect(inbox.markDone).not.toHaveBeenCalled();
      expect(tickets.ensureActiveTicket).not.toHaveBeenCalled();
    });
  });

  it('CRASH RESUME (review #1): a previously stored user message still gets its AI reply', async () => {
    // previous attempt crashed AFTER storing the user message — dedup-first and
    // addUserMessage both surface the existing row
    const stored = mkMessage({ id: 'm-existing', ticket_id: 't-1' });
    messages.findByTelegramUpdateId.mockResolvedValueOnce(stored);
    tickets.findById.mockResolvedValueOnce(mkTicket());
    messages.addUserMessage.mockResolvedValueOnce(stored);
    await process(rawUpdate());

    // the reply step runs — the user is never left unanswered
    expect(replyProvider.reply).toHaveBeenCalledTimes(1);
    expect(messages.addOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: MessageRole.ASSISTANT, in_reply_to_id: 'm-existing' }),
    );
    expect(inbox.markDone).toHaveBeenCalledWith('100');
  });

  it('CRASH RESUME (review #1): reply already stored → done without a second AI call', async () => {
    // previous attempt crashed AFTER storing the reply but BEFORE markDone
    messages.addUserMessage.mockResolvedValueOnce(mkMessage({ id: 'm-existing' }));
    messages.findAssistantReply.mockResolvedValueOnce(mkMessage({ id: 'm-reply' }));
    await process(rawUpdate());

    expect(replyProvider.reply).not.toHaveBeenCalled();
    expect(messages.addOutboundMessage).not.toHaveBeenCalled(); // reply only — the announcement moved into the ticket transaction
    expect(inbox.markDone).toHaveBeenCalledWith('100');
  });

  it('survives a duplicate assistant reply (crash retry) and still marks the update done', async () => {
    messages.addOutboundMessage
      .mockImplementationOnce(() => Promise.reject(new ConflictException('dup'))); // reply already exists
    await process(rawUpdate());
    expect(inbox.markDone).toHaveBeenCalledWith('100');
  });

  it('records the failure reason on the inbox row when processing throws', async () => {
    replyProvider.reply.mockRejectedValueOnce(new Error('provider exploded'));
    await process(rawUpdate()); // processSafely swallows the error
    expect(inbox.recordError).toHaveBeenCalledWith('100', 'provider exploded');
    expect(inbox.markDone).not.toHaveBeenCalled();
  });

  it('processes two updates of the same chat strictly in order', async () => {
    const order: string[] = [];
    replyProvider.reply.mockImplementation(async () => {
      order.push('reply');
      return { content: 'پاسخ', meta: null };
    });
    messages.addUserMessage.mockImplementation(async (input: { content: string }) => {
      order.push(`user:${input.content}`);
      return mkMessage();
    });

    const first = process(rawUpdate({ message_id: 1, text: 'اول' }));
    const second = process(rawUpdate({ message_id: 2, text: 'دوم' }));
    await Promise.all([first, second]);

    expect(order[0]).toBe('user:اول');
    expect(order[1]).toBe('reply');
    expect(order[2]).toBe('user:دوم');
  });
});
