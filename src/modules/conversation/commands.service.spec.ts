import { CommandsService, parseCommand } from './commands.service';
import { TicketsService } from '../tickets/tickets.service';
import { TelegramGateway } from '../telegram/telegram-gateway.interface';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { Ticket } from '../../database/entities/ticket.entity';
import { TicketDepartment, TicketStatus } from '../../database/enums';
import { mainMenuKeyboard } from '../telegram/keyboards';

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
  });
  it('returns null for plain text', () => {
    expect(parseCommand('سلام')).toBeNull();
    expect(parseCommand('/')).toBeNull();
  });
});

describe('CommandsService (feature round)', () => {
  let service: CommandsService;
  let tickets: {
    findActiveTicket: jest.Mock;
    findLastTicket: jest.Mock;
    changeStatus: jest.Mock;
  };
  let registration: { isComplete: jest.Mock; start: jest.Mock };
  let ticketFlow: { start: jest.Mock };
  let myTickets: { show: jest.Mock };
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
    botState = { clear: jest.fn().mockResolvedValue(undefined) };
    gateway = { active: true, sendMessage: jest.fn().mockResolvedValue({ message_id: '1' }) };
    service = new CommandsService(
      tickets as unknown as TicketsService,
      registration as never,
      ticketFlow as never,
      myTickets as never,
      botState as never,
      gateway as unknown as TelegramGateway,
    );
  });

  it('/new with a completed profile starts the WIZARD (no auto-ticket anymore)', async () => {
    await service.handle(mkUser(), '555', { name: 'new', raw: '/new' });
    expect(ticketFlow.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'u-1' }), '555');
  });

  it('/new is BLOCKED for a user without a completed profile (§1) — registration starts instead', async () => {
    registration.isComplete.mockReturnValue(false);
    await service.handle(mkUser({ profile_completed_at: null }), '555', { name: 'new', raw: '/new' });
    expect(ticketFlow.start).not.toHaveBeenCalled();
    expect(registration.start).toHaveBeenCalledWith(expect.anything(), '555');
  });

  it('/mytickets shows the user list via MyTicketsService', async () => {
    await service.handle(mkUser(), '555', { name: 'mytickets', raw: '/mytickets' });
    expect(myTickets.show).toHaveBeenCalledWith(expect.objectContaining({ id: 'u-1' }), '555', 1);
  });

  it('/mytickets is gated on the profile', async () => {
    registration.isComplete.mockReturnValue(false);
    await service.handle(mkUser({ profile_completed_at: null }), '555', { name: 'mytickets', raw: '/mytickets' });
    expect(myTickets.show).not.toHaveBeenCalled();
    expect(registration.start).toHaveBeenCalled();
  });

  it('/start clears stale state and greets a registered user with the main menu', async () => {
    await service.handle(mkUser(), '555', { name: 'start', raw: '/start' });
    expect(botState.clear).toHaveBeenCalledWith('u-1');
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: '555',
        text: expect.stringContaining('خوش آمدید'),
        reply_markup: mainMenuKeyboard(),
      }),
    );
  });

  it('/start for an UNREGISTERED user launches registration step 1', async () => {
    registration.isComplete.mockReturnValue(false);
    await service.handle(mkUser({ profile_completed_at: null }), '555', { name: 'start', raw: '/start' });
    expect(registration.start).toHaveBeenCalledWith(expect.anything(), '555');
    expect(gateway.sendMessage).not.toHaveBeenCalled(); // the registration service sends
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

  it('/cancel clears any flow state and returns to the main menu (§8)', async () => {
    await service.handle(mkUser(), '555', { name: 'cancel', raw: '/cancel' });
    expect(botState.clear).toHaveBeenCalledWith('u-1');
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ reply_markup: mainMenuKeyboard() }),
    );
  });

  it('/profile renders the registered profile card', async () => {
    await service.handle(mkUser({ username: 'ali' }), '555', { name: 'profile', raw: '/profile' });
    const call = gateway.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('علی رضایی');
    expect(call.text).toContain('09123456789');
    expect(call.text).toContain('@ali');
  });

  it('unknown commands get the (new) help guide', async () => {
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
