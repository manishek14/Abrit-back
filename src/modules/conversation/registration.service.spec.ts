import { RegistrationService, isValidFullName, normalizeIranianMobile } from './registration.service';
import { UsersService } from '../users/users.service';
import { BotStateService } from './bot-state.service';
import { TelegramGateway } from '../telegram/telegram-gateway.interface';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { registrationPhoneKeyboard } from '../telegram/keyboards';

const mkUser = (over: Partial<TelegramUser> = {}): TelegramUser =>
  ({ id: 'u-1', telegram_id: '700100200', chat_id: '700100200', ...over }) as TelegramUser;

describe('phone/name validators (feature §1)', () => {
  it('normalizeIranianMobile accepts all documented formats', () => {
    expect(normalizeIranianMobile('09123456789')).toBe('09123456789');
    expect(normalizeIranianMobile('9123456789')).toBe('09123456789');
    expect(normalizeIranianMobile('+989123456789')).toBe('09123456789');
    expect(normalizeIranianMobile('00989123456789')).toBe('09123456789');
    expect(normalizeIranianMobile('0912 345 6789')).toBe('09123456789');
  });

  it('normalizeIranianMobile rejects invalid numbers', () => {
    expect(normalizeIranianMobile('12345')).toBeNull();
    expect(normalizeIranianMobile('08123456789')).toBeNull();
    expect(normalizeIranianMobile('+987123456789')).toBeNull();
    expect(normalizeIranianMobile('hello')).toBeNull();
    expect(normalizeIranianMobile('')).toBeNull();
  });

  it('isValidFullName requires two+ letter parts, no digits', () => {
    expect(isValidFullName('علی رضایی')).toBe(true);
    expect(isValidFullName('Ali   Rezaei')).toBe(true);
    expect(isValidFullName('محمدرضا گلزار')).toBe(true);
    expect(isValidFullName('علی')).toBe(false); // single word
    expect(isValidFullName('علی 123')).toBe(false); // digits
    expect(isValidFullName('a b')).toBe(false); // parts too short
    expect(isValidFullName('')).toBe(false);
  });
});

describe('RegistrationService (feature §1 — پروفایل اجباری)', () => {
  let service: RegistrationService;
  let users: { isProfileComplete: jest.Mock; completeProfile: jest.Mock; setBotState: jest.Mock };
  let botState: { get: jest.Mock; set: jest.Mock; clear: jest.Mock };
  let gateway: { active: boolean; sendMessage: jest.Mock };

  beforeEach(() => {
    users = {
      isProfileComplete: jest.fn((u: TelegramUser) => !!u.profile_completed_at),
      completeProfile: jest.fn(async (_id: string, p: { full_name: string; phone: string }) => ({
        ...mkUser({ full_name: p.full_name, phone: p.phone, profile_completed_at: new Date() }),
      })),
      setBotState: jest.fn().mockResolvedValue(undefined),
    };
    botState = { get: jest.fn(), set: jest.fn(), clear: jest.fn() };
    gateway = { active: true, sendMessage: jest.fn().mockResolvedValue({ message_id: '1' }) };
    service = new RegistrationService(
      users as unknown as UsersService,
      botState as unknown as BotStateService,
      gateway as unknown as TelegramGateway,
    );
  });

  it('start sets REGISTER_NAME and sends the exact welcome message (remove_keyboard)', async () => {
    await service.start(mkUser(), '555');
    expect(botState.set).toHaveBeenCalledWith('u-1', 'REGISTER_NAME');
    const call = gateway.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('به ABRIT خوش آمدید');
    expect(call.text).toContain('نام و نام خانوادگی');
    expect(call.reply_markup).toEqual({ remove_keyboard: true });
  });

  it('start NEVER prefixes a restriction message — the gate owns it (§1/§2)', async () => {
    await service.start(mkUser(), '555');
    expect(gateway.sendMessage.mock.calls[0][0].text).not.toContain('باید پروفایل');
  });

  it('handleText: valid name → REGISTER_PHONE + the phone keyboard (request_contact)', async () => {
    botState.get.mockResolvedValue({ flow: 'REGISTER_NAME', data: {}, updated_at: new Date().toISOString() });

    const consumed = await service.handleText(mkUser(), '555', 'علی رضایی');

    expect(consumed).toBe(true);
    expect(botState.set).toHaveBeenCalledWith('u-1', 'REGISTER_PHONE', { name: 'علی رضایی' });
    const call = gateway.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('شماره همراه');
    expect(call.reply_markup).toEqual(registrationPhoneKeyboard());
  });

  it('handleText: invalid name stays in step with an error (no state advance)', async () => {
    botState.get.mockResolvedValue({ flow: 'REGISTER_NAME', data: {}, updated_at: new Date().toISOString() });

    await service.handleText(mkUser(), '555', '12345');

    expect(botState.set).not.toHaveBeenCalledWith('u-1', 'REGISTER_PHONE', expect.anything());
    expect(gateway.sendMessage.mock.calls[0][0].text).toContain('معتبر نیست');
  });

  it('handleText: typed phone fallback completes the profile and shows the main menu', async () => {
    botState.get.mockResolvedValue({
      flow: 'REGISTER_PHONE',
      data: { name: 'علی رضایی' },
      updated_at: new Date().toISOString(),
    });

    const consumed = await service.handleText(mkUser(), '555', '0912 345 6789');

    expect(consumed).toBe(true);
    expect(users.completeProfile).toHaveBeenCalledWith('u-1', {
      full_name: 'علی رضایی',
      phone: '09123456789',
    });
    expect(botState.clear).toHaveBeenCalledWith('u-1');
    const call = gateway.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('پروفایل شما تکمیل شد');
    expect(call.reply_markup).toBeDefined();
  });

  it('handleText: invalid typed phone keeps the user in REGISTER_PHONE', async () => {
    botState.get.mockResolvedValue({
      flow: 'REGISTER_PHONE',
      data: { name: 'علی رضایی' },
      updated_at: new Date().toISOString(),
    });

    await service.handleText(mkUser(), '555', '123');

    expect(users.completeProfile).not.toHaveBeenCalled();
    expect(botState.clear).not.toHaveBeenCalled();
    expect(gateway.sendMessage.mock.calls[0][0].text).toContain('معتبر نیست');
  });

  it('handleContact: verifies the contact OWNER (§1) — a foreign contact is rejected', async () => {
    botState.get.mockResolvedValue({
      flow: 'REGISTER_PHONE',
      data: { name: 'علی رضایی' },
      updated_at: new Date().toISOString(),
    });

    await service.handleContact(mkUser({ telegram_id: '700100200' }), '555', {
      phone_number: '+989123456789',
      user_id: 999000111, // someone else's contact
    });

    expect(users.completeProfile).not.toHaveBeenCalled();
    expect(gateway.sendMessage.mock.calls[0][0].text).toContain('متعلق به حساب شما نیست');
  });

  it('handleContact: own contact completes registration', async () => {
    botState.get.mockResolvedValue({
      flow: 'REGISTER_PHONE',
      data: { name: 'علی رضایی' },
      updated_at: new Date().toISOString(),
    });

    await service.handleContact(mkUser({ telegram_id: '700100200' }), '555', {
      phone_number: '+989123456789',
      user_id: 700100200,
    });

    expect(users.completeProfile).toHaveBeenCalledWith('u-1', {
      full_name: 'علی رضایی',
      phone: '09123456789',
    });
    expect(botState.clear).toHaveBeenCalledWith('u-1');
  });

  it('handleContact outside the phone step does NOT register anything', async () => {
    botState.get.mockResolvedValue(null);
    await service.handleContact(mkUser(), '555', { phone_number: '09123456789', user_id: 1 });
    expect(users.completeProfile).not.toHaveBeenCalled();
  });

  it('handleText returns false when NO registration state exists (router falls through)', async () => {
    botState.get.mockResolvedValue(null);
    expect(await service.handleText(mkUser(), '555', 'علی رضایی')).toBe(false);
    expect(gateway.sendMessage).not.toHaveBeenCalled();
  });
});
