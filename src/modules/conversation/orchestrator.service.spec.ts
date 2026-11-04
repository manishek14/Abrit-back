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
import { BotUpdateStatus, MessageRole } from '../../database/enums';

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
  let inbox: { claim: jest.Mock; markDone: jest.Mock };
  let users: { upsertTelegramUser: jest.Mock };
  let tickets: { ensureActiveTicket: jest.Mock };
  let messages: { addUserMessage: jest.Mock; addOutboundMessage: jest.Mock };
  let commands: { handle: jest.Mock };
  let replyProvider: { reply: jest.Mock };
  let gateway: { active: boolean; sendMessage: jest.Mock };

  /** Enqueue the given payload: claim returns it, so the test drives exactly this shape. */
  const process = (payload: Record<string, unknown>) => {
    inbox.claim.mockResolvedValueOnce(mkUpdate(payload));
    return service.enqueue(mkUpdate(payload));
  };

  beforeEach(() => {
    inbox = { claim: jest.fn(), markDone: jest.fn() };
    users = { upsertTelegramUser: jest.fn() };
    tickets = { ensureActiveTicket: jest.fn() };
    messages = { addUserMessage: jest.fn(), addOutboundMessage: jest.fn() };
    commands = { handle: jest.fn() };
    replyProvider = { reply: jest.fn() };
    gateway = { active: true, sendMessage: jest.fn().mockResolvedValue({ message_id: '1' }) };

    users.upsertTelegramUser.mockResolvedValue(mkUser());
    tickets.ensureActiveTicket.mockResolvedValue({ ticket: mkTicket(), created: true });
    messages.addUserMessage.mockResolvedValue(mkMessage());
    messages.addOutboundMessage.mockResolvedValue(mkMessage());
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

  it('silently drops messages from blocked users', async () => {
    users.upsertTelegramUser.mockResolvedValueOnce(mkUser({ is_blocked: true }));
    await process(rawUpdate());
    expect(inbox.markDone).toHaveBeenCalledWith('100');
    expect(tickets.ensureActiveTicket).not.toHaveBeenCalled();
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

  it('runs the full ticket flow for plain text: announce → store user msg → reply → outbox', async () => {
    await process(rawUpdate());

    expect(tickets.ensureActiveTicket).toHaveBeenCalledWith('u-1', 'سلام، مشکل دارم');
    const calls = messages.addOutboundMessage.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toMatchObject({ role: MessageRole.SYSTEM, ticket_id: 't-1' });
    expect(calls[0][0].content).toContain('TKT-10001');
    expect(messages.addUserMessage).toHaveBeenCalledWith({
      ticket_id: 't-1',
      content: 'سلام، مشکل دارم',
      telegram_update_id: '100',
    });
    expect(replyProvider.reply).toHaveBeenCalledTimes(1);
    expect(calls[1][0]).toMatchObject({
      role: MessageRole.ASSISTANT,
      in_reply_to_id: 'm-1',
      content: 'پاسخ دستیار',
    });
    expect(inbox.markDone).toHaveBeenCalledWith('100');
  });

  it('does not announce an existing ticket twice', async () => {
    tickets.ensureActiveTicket.mockResolvedValueOnce({ ticket: mkTicket(), created: false });
    await process(rawUpdate());
    expect(messages.addOutboundMessage).toHaveBeenCalledTimes(1); // assistant reply only
  });

  it('treats a duplicate stored user message (replay) as processed — no AI call', async () => {
    messages.addUserMessage.mockRejectedValueOnce(new ConflictException('dup'));
    await process(rawUpdate());
    expect(replyProvider.reply).not.toHaveBeenCalled();
    expect(inbox.markDone).toHaveBeenCalledWith('100');
  });

  it('survives a duplicate assistant reply (crash retry) and still marks the update done', async () => {
    messages.addOutboundMessage
      .mockImplementationOnce(async () => mkMessage()) // SYSTEM announcement
      .mockImplementationOnce(() => Promise.reject(new ConflictException('dup'))); // reply already exists
    await process(rawUpdate());
    expect(inbox.markDone).toHaveBeenCalledWith('100');
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
