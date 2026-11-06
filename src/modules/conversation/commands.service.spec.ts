import { CommandsService, parseCommand } from './commands.service';
import { TicketsService } from '../tickets/tickets.service';
import { TelegramGateway } from '../telegram/telegram-gateway.interface';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { Ticket } from '../../database/entities/ticket.entity';
import { TicketDepartment, TicketStatus } from '../../database/enums';
import { profileCardKeyboard, profileGateKeyboard } from '../telegram/keyboards';
import { REG_REQUIRED } from '../../common/bot-messages';

const mkUser = (over: Partial<TelegramUser> = {}): TelegramUser =>
  ({
    id: 'u-1',
    chat_id: '555',
    telegram_id: '555',
    full_name: 'علی رضایی',
    phone: '09123456789',
    profile_completed_at: new Date(),
    ...over,
  }) as TelegramUser;
const mkTicket = (over: Partial<Ticket> = {}): Ticket =>
  ({
    id: 't-1',
    ticket_number: 'TKT-10001',
    user_id: 'u-1',
    status: TicketStatus.OPEN,
    subject: 'مشکل پرداخت',
    department: TicketDepartment.FINANCE,
    ...over,
  }) as Ticket;

describe('parseCommand', () => {
  it('extracts /new, /new@BotName and /status args', () => {
    expect(parseCommand('/new')?.name).toBe('new');
    expect(parseCommand('/new@AbrITBot')?.name).toBe('new');
    expect(parseCommand('/mytickets')?.name).toBe('mytickets');
    expect(parseCommand('/status توضیح')?.name).toBe('status');
    expect(parseCommand('/chatbot')?.name).toBe('chatbot');
  });
  it('returns null for plain text', () => {
    expect(parseCommand('سلام')).toBeNull();
    expect(parseCommand('/')).toBeNull();
  });
});

describe('CommandsService (request §1/§2/§4/§6/§7)', () => {
  let service: CommandsService;
  let tickets: {
    findActiveTicket: jest.Mock;
    findLastTicket: jest.Mock;
    changeStatus: jest.Mock;
  };
  let registration: { isComplete: jest.Mock; start: jest.Mock };
  let ticketFlow: { start: jest.Mock };
  let myTickets: { show: jest.Mock };
  let chatbot: { enter: jest.Mock };
  let botState: { clear: jest.Mock };
  let gateway: { active: boolean; sendMessage: jest.Mock };

  beforeEach(() => {
    tickets = {
      findActiveTicket: jest.fn(),
      findLastTicket: jest.fn(),
      changeStatus: jest.fn().mockResolvedValue({ changed: true }),
    };
    registration = { isComplete: jest.fn(() => true), start: jest.fn().mockResolvedValue(undefined) };
    ticketFlow = { start: jest.fn().mockResolvedValue(undefined) };
    myTickets = { show: jest.fn().mockResolvedValue(undefined) };
    chatbot = { enter: jest.fn().mockResolvedValue(undefined) };
    botState = { clear: jest.fn().mockResolvedValue(undefined) };
    gateway = { active: true, sendMessage: jest.fn().mockResolvedValue({ message_id: '1' }) };
    service = new CommandsService(
      tickets as unknown as TicketsService,
      registration as never,
      ticketFlow as never,
      myTickets as never,
      chatbot as never,
      botState as never,
      gateway as unknown as TelegramGateway,
    );
  });

  it('/new with a completed profile starts the WIZARD (no auto-ticket anymore)', async () => {
    await service.handle(mkUser(), '555', { name: 'new', raw: '/new' });
    expect(ticketFlow.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'u-1' }), '555');
  });

  it('§2: /new without a profile → restriction + «تکمیل پروفایل»-ONLY keyboard, NO auto registration', async () => {
    registration.isComplete.mockReturnValue(false);
    await service.handle(mkUser({ profile_completed_at: null }), '555', { name: 'new', raw: '/new' });
    expect(ticketFlow.start).not.toHaveBeenCalled();
    expect(registration.start).not.toHaveBeenCalled(); // the user opts in via the button
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: REG_REQUIRED,
        reply_markup: profileGateKeyboard(),
      }),
    );
    const kb = gateway.sendMessage.mock.calls[0][0].reply_markup as { keyboard: { text: string }[][] };
    expect(kb.keyboard.flat()).toHaveLength(1);
    expect(kb.keyboard[0][0].text).toBe('👤 تکمیل پروفایل');
  });

  it('§2: /mytickets is gated the same way (restriction + gate keyboard)', async () => {
    registration.isComplete.mockReturnValue(false);
    await service.handle(mkUser({ profile_completed_at: null }), '555', { name: 'mytickets', raw: '/mytickets' });
    expect(myTickets.show).not.toHaveBeenCalled();
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ reply_markup: profileGateKeyboard() }),
    );
  });

  it('/mytickets shows the user list via MyTicketsService', async () => {
    await service.handle(mkUser(), '555', { name: 'mytickets', raw: '/mytickets' });
    expect(myTickets.show).toHaveBeenCalledWith(expect.objectContaining({ id: 'u-1' }), '555', 1);
  });

  it('/start clears stale state and greets a registered user with the main menu', async () => {
    await service.handle(mkUser(), '555', { name: 'start', raw: '/start' });
    expect(botState.clear).toHaveBeenCalledWith('u-1');
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: '555',
        text: expect.stringContaining('خوش آمدید'),
        reply_markup: expect.anything(),
      }),
    );
  });

  it('/start for an UNREGISTERED user launches registration step 1', async () => {
    registration.isComplete.mockReturnValue(false);
    await service.handle(mkUser({ profile_completed_at: null }), '555', { name: 'start', raw: '/start' });
    expect(registration.start).toHaveBeenCalledWith(expect.anything(), '555');
    expect(gateway.sendMessage).not.toHaveBeenCalled(); // the registration service sends
  });

  it('§1: /profile with an INCOMPLETE profile enters the flow directly — NO restriction message', async () => {
    registration.isComplete.mockReturnValue(false);
    await service.handle(mkUser({ profile_completed_at: null }), '555', { name: 'profile', raw: '/profile' });
    expect(registration.start).toHaveBeenCalledWith(expect.anything(), '555');
    // the only send (if any) must NOT be the restriction text
    for (const call of gateway.sendMessage.mock.calls) {
      expect(call[0].text).not.toContain('ابتدا باید پروفایل');
    }
  });

  it('§6: /profile renders the card with name + phone ONLY (no username, ever)', async () => {
    await service.handle(mkUser({ username: 'ali' }), '555', { name: 'profile', raw: '/profile' });
    const call = gateway.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('علی رضایی');
    expect(call.text).toContain('09123456789');
    expect(call.text).not.toContain('@ali');
    expect(call.text).not.toContain('یوزرنیم');
    expect(call.reply_markup).toEqual(profileCardKeyboard());
  });

  it('§4: /chatbot with a completed profile enters chatbot mode', async () => {
    await service.handle(mkUser(), '555', { name: 'chatbot', raw: '/chatbot' });
    expect(chatbot.enter).toHaveBeenCalledWith(expect.objectContaining({ id: 'u-1' }), '555');
  });

  it('§4: /chatbot without a profile gets the §2 restriction + gate keyboard', async () => {
    registration.isComplete.mockReturnValue(false);
    await service.handle(mkUser({ profile_completed_at: null }), '555', { name: 'chatbot', raw: '/chatbot' });
    expect(chatbot.enter).not.toHaveBeenCalled();
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: REG_REQUIRED, reply_markup: profileGateKeyboard() }),
    );
  });

  it('/status shows the active ticket with its Persian status + department labels', async () => {
    tickets.findActiveTicket.mockResolvedValueOnce(mkTicket({ status: TicketStatus.IN_PROGRESS }));
    await service.handle(mkUser(), '555', { name: 'status', raw: '/status' });
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(/TKT-10001[\s\S]*مالی[\s\S]*در حال بررسی/),
      }),
    );
  });

  it('/status falls back to the last ticket and to "no tickets" hint', async () => {
    tickets.findActiveTicket.mockResolvedValueOnce(null);
    tickets.findLastTicket.mockResolvedValueOnce(mkTicket({ status: TicketStatus.CLOSED }));
    await service.handle(mkUser(), '555', { name: 'status', raw: '/status' });
    expect(gateway.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('بسته') }));

    tickets.findActiveTicket.mockResolvedValue(null);
    tickets.findLastTicket.mockResolvedValue(null);
    await service.handle(mkUser(), '555', { name: 'status', raw: '/status' });
    expect(gateway.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining('وجود ندارد') }),
    );
  });

  it('/close closes the active ticket as USER (durable SYSTEM notification follows)', async () => {
    tickets.findActiveTicket.mockResolvedValueOnce(mkTicket());
    await service.handle(mkUser(), '555', { name: 'close', raw: '/close' });
    expect(tickets.changeStatus).toHaveBeenCalledWith('t-1', 'CLOSED', 'USER');
  });

  it('/close without an active ticket says so', async () => {
    tickets.findActiveTicket.mockResolvedValueOnce(null);
    await service.handle(mkUser(), '555', { name: 'close', raw: '/close' });
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('ندارید') }),
    );
  });

  it('/cancel clears ANY flow state (wizard, chatbot, …) and returns to the main menu (§8)', async () => {
    await service.handle(mkUser(), '555', { name: 'cancel', raw: '/cancel' });
    expect(botState.clear).toHaveBeenCalledWith('u-1');
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  it('§7: /help shows the command list incl. /chatbot and never calls OpenRouter', async () => {
    await service.handle(mkUser(), '555', { name: 'help', raw: '/help' });
    const call = gateway.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('/chatbot');
    expect(call.text).toContain('/mytickets');
    expect(chatbot.enter).not.toHaveBeenCalled();
  });

  it('unknown commands get the help guide', async () => {
    await service.handle(mkUser(), '555', { name: 'whatever', raw: '/whatever' });
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('/mytickets') }),
    );
  });

  it('skips ephemeral sends entirely while the gateway is inactive', async () => {
    gateway.active = false;
    await service.handle(mkUser(), '555', { name: 'start', raw: '/start' });
    expect(gateway.sendMessage).not.toHaveBeenCalled();
  });
});
