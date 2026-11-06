import { CommandsService, parseCommand } from './commands.service';
import { TicketsService } from '../tickets/tickets.service';
import { TelegramGateway } from '../telegram/telegram-gateway.interface';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { Ticket } from '../../database/entities/ticket.entity';
import { MessageRole, TicketStatus } from '../../database/enums';

const mkUser = (): TelegramUser => ({ id: 'u-1', chat_id: '555' }) as TelegramUser;
const mkTicket = (over: Partial<Ticket> = {}): Ticket =>
  ({ id: 't-1', ticket_number: 'TKT-10001', user_id: 'u-1', status: TicketStatus.OPEN, ...over }) as Ticket;

describe('parseCommand', () => {
  it('extracts /new, /new@BotName and /status args', () => {
    expect(parseCommand('/new')?.name).toBe('new');
    expect(parseCommand('/new@AbrITBot')?.name).toBe('new');
    expect(parseCommand('/status توضیح')?.name).toBe('status');
  });
  it('returns null for plain text', () => {
    expect(parseCommand('سلام')).toBeNull();
    expect(parseCommand('/')).toBeNull();
  });
});

describe('CommandsService', () => {
  let service: CommandsService;
  let tickets: { ensureActiveTicket: jest.Mock; findActiveTicket: jest.Mock; findLastTicket: jest.Mock; changeStatus: jest.Mock };
  let gateway: { active: boolean; sendMessage: jest.Mock };

  beforeEach(() => {
    tickets = {
      ensureActiveTicket: jest.fn(),
      findActiveTicket: jest.fn(),
      findLastTicket: jest.fn(),
      changeStatus: jest.fn().mockResolvedValue({ changed: true }),
    };
    gateway = { active: true, sendMessage: jest.fn().mockResolvedValue({ message_id: '1' }) };
    service = new CommandsService(
      tickets as unknown as TicketsService,
      gateway as unknown as TelegramGateway,
    );
  });

  it('/new creates a ticket whose ATOMIC announcement was stored in the creation transaction (review fix)', async () => {
    tickets.ensureActiveTicket.mockResolvedValueOnce({
      ticket: mkTicket(),
      created: true,
      announcement: { id: 'm-a', role: MessageRole.SYSTEM, content: 'تیکت TKT-10001 ایجاد شد.\nلطفاً شرح مشکل خود را بنویسید.' },
    });

    await service.handle(mkUser(), '555', { name: 'new', raw: '/new' });

    // the announcement is passed to ensureActiveTicket and lives in ITS
    // transaction — a crash between ticket creation and announcement is
    // impossible, so the orchestrator writes nothing itself
    expect(tickets.ensureActiveTicket).toHaveBeenCalledWith(
      'u-1',
      null,
      expect.objectContaining({ announce: expect.any(Function) }),
    );
    const announce = tickets.ensureActiveTicket.mock.calls[0][2].announce as (n: string) => string;
    expect(announce('TKT-42')).toContain('TKT-42');
    expect(announce('TKT-42')).toContain('لطفاً شرح مشکل خود را بنویسید');
    expect(gateway.sendMessage).not.toHaveBeenCalled(); // durable path — nothing ephemeral
  });

  it('/new with an active ticket answers ephemerally', async () => {
    tickets.ensureActiveTicket.mockResolvedValueOnce({ ticket: mkTicket(), created: false, announcement: null });

    await service.handle(mkUser(), '555', { name: 'new', raw: '/new' });

    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: '555', text: expect.stringContaining('فعال') }),
    );
  });

  it('/status shows the active ticket with its Persian status label', async () => {
    tickets.findActiveTicket.mockResolvedValueOnce(mkTicket({ status: TicketStatus.IN_PROGRESS }));

    await service.handle(mkUser(), '555', { name: 'status', raw: '/status' });

    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(/TKT-10001.*در حال بررسی/s),
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
    expect(gateway.sendMessage).not.toHaveBeenCalled();
  });

  it('/close without an active ticket says so', async () => {
    tickets.findActiveTicket.mockResolvedValueOnce(null);
    await service.handle(mkUser(), '555', { name: 'close', raw: '/close' });
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('ندارید') }),
    );
  });

  it('unknown commands get the help pointer; /start and /help reply with the guide', async () => {
    await service.handle(mkUser(), '555', { name: 'whatever', raw: '/whatever' });
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('ناشناخته') }),
    );

    await service.handle(mkUser(), '555', { name: 'start', raw: '/start' });
    expect(gateway.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining('خوش آمدید') }),
    );

    await service.handle(mkUser(), '555', { name: 'help', raw: '/help' });
    expect(gateway.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining('راهنمای دستورات') }),
    );
  });

  it('skips ephemeral sends entirely while the gateway is inactive', async () => {
    gateway.active = false;
    await service.handle(mkUser(), '555', { name: 'start', raw: '/start' });
    expect(gateway.sendMessage).not.toHaveBeenCalled();
  });
});
