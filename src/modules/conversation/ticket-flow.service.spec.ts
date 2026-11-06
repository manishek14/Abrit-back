import { TicketFlowService } from './ticket-flow.service';
import { TicketsService } from '../tickets/tickets.service';
import { MessagesService } from '../messages/messages.service';
import { UsersService } from '../users/users.service';
import { BotStateService } from './bot-state.service';
import { RegistrationService } from './registration.service';
import { TelegramGateway } from '../telegram/telegram-gateway.interface';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { Ticket } from '../../database/entities/ticket.entity';
import { TicketDepartment, TicketStatus } from '../../database/enums';
import {
  departmentKeyboard,
  mainMenuKeyboard,
  ticketCancelKeyboard,
} from '../telegram/keyboards';
import { stateWith } from './bot-state.test-util';

const mkUser = (over: Partial<TelegramUser> = {}): TelegramUser =>
  ({
    id: 'u-1',
    telegram_id: '700100200',
    chat_id: '700100200',
    profile_completed_at: new Date(),
    full_name: 'علی رضایی',
    phone: '09123456789',
    ...over,
  }) as TelegramUser;

describe('TicketFlowService (feature §3 + §4 — the wizard)', () => {
  let service: TicketFlowService;
  let tickets: {
    findActiveTicket: jest.Mock;
    createTicketWithFirstMessage: jest.Mock;
    findById: jest.Mock;
  };
  let messages: { findByTelegramUpdateId: jest.Mock };
  let users: { setBotState: jest.Mock; isProfileComplete: jest.Mock };
  let botState: { get: jest.Mock; set: jest.Mock; clear: jest.Mock };
  let registration: { isComplete: jest.Mock };
  let gateway: { active: boolean; sendMessage: jest.Mock };

  beforeEach(() => {
    tickets = {
      findActiveTicket: jest.fn().mockResolvedValue(null),
      createTicketWithFirstMessage: jest.fn(),
      findById: jest.fn(),
    };
    messages = { findByTelegramUpdateId: jest.fn().mockResolvedValue(null) };
    users = { setBotState: jest.fn(), isProfileComplete: jest.fn(() => true) };
    botState = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
    };
    registration = { isComplete: jest.fn(() => true) };
    gateway = { active: true, sendMessage: jest.fn().mockResolvedValue({ message_id: '1' }) };
    service = new TicketFlowService(
      tickets as unknown as TicketsService,
      messages as unknown as MessagesService,
      users as unknown as UsersService,
      botState as unknown as BotStateService,
      registration as unknown as RegistrationService,
      gateway as unknown as TelegramGateway,
    );
  });

  it('start asks for the title with the cancel keyboard', async () => {
    await service.start(mkUser(), '555');
    expect(botState.set).toHaveBeenCalledWith('u-1', 'TICKET_TITLE');
    const call = gateway.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('عنوان تیکت');
    expect(call.reply_markup).toEqual(ticketCancelKeyboard());
  });

  it('start refuses when an active ticket exists (one-active-per-user policy)', async () => {
    tickets.findActiveTicket.mockResolvedValueOnce({ ticket_number: 'TKT-10001' });
    await service.start(mkUser(), '555');
    expect(botState.set).not.toHaveBeenCalled();
    expect(gateway.sendMessage.mock.calls[0][0].text).toContain('تیکت فعال دارید');
  });

  it('valid title → department keyboard (THE custom reply keyboard, §3)', async () => {
    botState.get.mockResolvedValue(stateWith('TICKET_TITLE'));

    await service.handleText(mkUser(), '555', 'مشکل در ورود به حساب', null);

    expect(botState.set).toHaveBeenCalledWith(
      'u-1',
      'TICKET_DEPARTMENT',
      expect.objectContaining({ title: 'مشکل در ورود به حساب' }),
    );
    const call = gateway.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('دپارتمان');
    expect(call.reply_markup).toEqual(departmentKeyboard());
  });

  it('invalid title (too short) stays in the TITLE step', async () => {
    botState.get.mockResolvedValue(stateWith('TICKET_TITLE'));
    await service.handleText(mkUser(), '555', 'ع', null);
    expect(botState.set).not.toHaveBeenCalled();
    expect(gateway.sendMessage.mock.calls[0][0].text).toContain('معتبر نیست');
  });

  it('free-text department is REJECTED — only exact keyboard labels pass (§3)', async () => {
    botState.get.mockResolvedValue(stateWith('TICKET_DEPARTMENT', { title: 'مشکل پرداخت' }));

    await service.handleText(mkUser(), '555', 'بازگشت به دیروز', null);

    expect(botState.set).not.toHaveBeenCalledWith('u-1', 'TICKET_DESCRIPTION', expect.anything());
    const call = gateway.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('یکی از گزینه‌ها');
    expect(call.reply_markup).toEqual(departmentKeyboard());
  });

  it('exact department label → DESCRIPTION step', async () => {
    botState.get.mockResolvedValue(stateWith('TICKET_DEPARTMENT', { title: 'مشکل پرداخت' }));

    await service.handleText(mkUser(), '555', '💰 مالی', null);

    expect(botState.set).toHaveBeenCalledWith(
      'u-1',
      'TICKET_DESCRIPTION',
      expect.objectContaining({ department: TicketDepartment.FINANCE }),
    );
    expect(gateway.sendMessage.mock.calls[0][0].text).toContain('متن درخواست');
  });

  it('🔙 بازگشت in the department step returns to the title (state preserved)', async () => {
    botState.get.mockResolvedValue(stateWith('TICKET_DEPARTMENT', { title: 'مشکل پرداخت' }));
    await service.handleText(mkUser(), '555', '🔙 بازگشت', null);
    expect(botState.set).toHaveBeenCalledWith('u-1', 'TICKET_TITLE', expect.anything());
  });

  it('finalize: creates ticket + first message + confirmation with Jalali date + MAIN MENU', async () => {
    const ticket = {
      id: 't-1',
      ticket_number: 'TKT-10001',
      subject: 'مشکل در ورود به حساب',
      department: TicketDepartment.TECHNICAL,
      status: TicketStatus.OPEN,
      created_at: new Date('2026-11-06T11:30:00Z'),
      user_id: 'u-1',
    } as Ticket;
    tickets.createTicketWithFirstMessage.mockResolvedValueOnce({ ticket, created: true, announcement: null });
    botState.get.mockImplementation(async () =>
      stateWith('TICKET_RETRY', {
        title: 'مشکل در ورود به حساب',
        department: TicketDepartment.TECHNICAL,
        description: 'وقتی وارد حساب می‌شوم خطا می‌دهد و نمی‌توانم ادامه دهم.',
      }),
    );

    await service.handleText(
      mkUser(),
      '555',
      'وقتی وارد حساب می‌شوم خطا می‌دهد و نمی‌توانم ادامه دهم.',
      '9001',
    );

    expect(tickets.createTicketWithFirstMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'u-1',
        subject: 'مشکل در ورود به حساب',
        department: TicketDepartment.TECHNICAL,
        telegram_update_id: '9001',
      }),
    );
    expect(botState.clear).toHaveBeenCalledWith('u-1'); // state cleaned after success (§4)
    const call = gateway.sendMessage.mock.calls.at(-1)![0];
    expect(call.text).toContain('تیکت شما با موفقیت ثبت شد');
    expect(call.text).toContain('۱۴۰۵/۰۸/۱۵'); // Jalali date of the REAL timestamp
    expect(call.parse_mode).toBe('HTML');
    expect(call.reply_markup).toEqual(mainMenuKeyboard());
  });

  it('§4: DB error during finalize → NO success message, state KEPT for retry', async () => {
    tickets.createTicketWithFirstMessage.mockRejectedValueOnce(new Error('db down'));
    botState.get.mockImplementation(async () =>
      stateWith('TICKET_RETRY', {
        title: 'مشکل در ورود به حساب',
        department: TicketDepartment.TECHNICAL,
        description: 'متن کامل درخواست کاربر اینجا قرار دارد.',
      }),
    );

    await service.handleText(mkUser(), '555', 'متن کامل درخواست کاربر اینجا قرار دارد.', '9002');

    expect(tickets.createTicketWithFirstMessage).toHaveBeenCalled();
    expect(botState.clear).not.toHaveBeenCalled(); // inputs are NOT lost (§4)
    const texts = gateway.sendMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('تیکت شما با موفقیت ثبت شد'))).toBe(false);
    expect(texts.some((t) => t.includes('خطایی در ثبت نهایی'))).toBe(true);
  });

  it('§4: retry after a failed finalize uses the SAME stored description and succeeds', async () => {
    const ticket = {
      id: 't-1',
      ticket_number: 'TKT-10002',
      subject: 'مشکل پرداخت',
      department: TicketDepartment.FINANCE,
      status: TicketStatus.OPEN,
      created_at: new Date(),
      user_id: 'u-1',
    } as Ticket;
    tickets.createTicketWithFirstMessage
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ ticket, created: true, announcement: null });
    botState.get.mockImplementation(async () =>
      stateWith('TICKET_RETRY', {
        title: 'مشکل پرداخت',
        department: TicketDepartment.FINANCE,
        description: 'پرداخت من دو بار کسر شده است لطفاً بررسی کنید.',
      }),
    );

    await service.handleText(mkUser(), '555', 'پرداخت من دو بار کسر شده است لطفاً بررسی کنید.', '9003');
    await service.handleText(mkUser(), '555', 'پرداخت من دو بار کسر شده است لطفاً بررسی کنید.', '9004');

    expect(tickets.createTicketWithFirstMessage).toHaveBeenCalledTimes(2);
    expect(tickets.createTicketWithFirstMessage.mock.calls[1][0].description).toBe(
      'پرداخت من دو بار کسر شده است لطفاً بررسی کنید.',
    );
    expect(botState.clear).toHaveBeenCalled();
  });

  it('❌ لغو ثبت تیکت cancels from ANY step and clears the state (§4)', async () => {
    const wizardFlows = [
      'TICKET_TITLE',
      'TICKET_DEPARTMENT',
      'TICKET_DESCRIPTION',
      'TICKET_RETRY',
    ] as const;
    for (const flow of wizardFlows) {
      gateway.sendMessage.mockClear();
      botState.get.mockResolvedValue(stateWith(flow, { title: 'x' }));
      const handled = await service.handleText(mkUser(), '555', '❌ لغو ثبت تیکت', null);
      expect(handled).toBe(true);
      expect(botState.clear).toHaveBeenCalledWith('u-1');
      const last = gateway.sendMessage.mock.calls.at(-1)![0];
      expect(last.reply_markup).toEqual(mainMenuKeyboard());
    }
  });

  it('handleText returns false with NO wizard state (router falls through)', async () => {
    botState.get.mockResolvedValue(null);
    expect(await service.handleText(mkUser(), '555', 'هر متنی', null)).toBe(false);
  });

  it('dedup-first: a stored message for THIS update skips ticket creation (sweeper re-run)', async () => {
    const existingTicket = {
      id: 't-9',
      ticket_number: 'TKT-10009',
      subject: 'x',
      department: TicketDepartment.FINANCE,
      status: TicketStatus.OPEN,
      created_at: new Date(),
      user_id: 'u-1',
    } as Ticket;
    messages.findByTelegramUpdateId.mockResolvedValueOnce({ id: 'm-1', ticket_id: 't-9' });
    tickets.findById.mockResolvedValueOnce(existingTicket);
    botState.get.mockImplementation(async () =>
      stateWith('TICKET_RETRY', {
        title: 'x',
        department: TicketDepartment.FINANCE,
        description: 'یک متن درخواست کامل برای تست.',
      }),
    );

    await service.handleText(mkUser(), '555', 'یک متن درخواست کامل برای تست.', '9005');

    expect(tickets.createTicketWithFirstMessage).not.toHaveBeenCalled();
    expect(tickets.findById).toHaveBeenCalledWith('t-9'); // pinned to the ORIGINAL ticket
    expect(botState.clear).toHaveBeenCalled(); // finalize still completes cleanly
    expect(gateway.sendMessage.mock.calls.at(-1)![0].text).toContain('تیکت شما با موفقیت ثبت شد');
  });
});
