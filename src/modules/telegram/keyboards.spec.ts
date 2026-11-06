import {
  DEPARTMENTS,
  DEPARTMENT_LABELS,
  departmentByLabel,
  departmentKeyboard,
  mainMenuKeyboard,
  myTicketsInlineKeyboard,
  profileCardKeyboard,
  profileGateKeyboard,
  registrationPhoneKeyboard,
  ticketCancelKeyboard,
  ticketViewKeyboard,
  chatbotKeyboard,
  MYT_PAGE_SIZE,
} from './keyboards';
import { TicketDepartment } from '../../database/enums';

describe('keyboard factory (feature §5)', () => {
  it('main menu contains exactly the five required buttons', () => {
    const kb = mainMenuKeyboard();
    const texts = kb.keyboard.flat().map((b) => b.text);
    expect(texts).toEqual([
      '🎫 ثبت تیکت جدید',
      '📋 تیکت‌های من',
      '🔍 پیگیری تیکت',
      '👤 پروفایل من',
      '❓ راهنما',
    ]);
  });

  it('phone keyboard carries a request_contact button (§1)', () => {
    const kb = registrationPhoneKeyboard();
    expect(kb.keyboard[0][0].request_contact).toBe(true);
  });

  it('department keyboard lists the 4 valid departments + back — nothing else', () => {
    const kb = departmentKeyboard();
    const texts = kb.keyboard.flat().map((b) => b.text);
    expect(texts).toEqual([
      '💰 مالی',
      '🎧 پشتیبانی',
      '⚙️ فنی',
      '💡 پیشنهادات و انتقادات',
      '🔙 بازگشت',
    ]);
  });

  it('department input validation accepts ONLY exact keyboard labels (§3)', () => {
    expect(departmentByLabel('💰 مالی')?.key).toBe(TicketDepartment.FINANCE);
    expect(departmentByLabel(' ⚙️ فنی ')?.key).toBe(TicketDepartment.TECHNICAL);
    expect(departmentByLabel('فنی')).toBeNull(); // free text can NEVER pick a department
    expect(departmentByLabel('financial')).toBeNull();
  });

  it('department labels cover every enum key', () => {
    for (const key of Object.values(TicketDepartment)) {
      expect(DEPARTMENT_LABELS[key]).toBeTruthy();
    }
    expect(DEPARTMENTS).toHaveLength(4);
  });

  it('wizard cancel keyboard shows only the cancel button', () => {
    expect(ticketCancelKeyboard().keyboard.flat().map((b) => b.text)).toEqual(['❌ لغو ثبت تیکت']);
  });

  it('ticket view keyboard matches the spec (§5)', () => {
    const texts = ticketViewKeyboard().keyboard.flat().map((b) => b.text);
    expect(texts).toEqual(['💬 ارسال پیام', '📋 اطلاعات تیکت', '🔙 بازگشت به تیکت‌های من']);
  });

  it('inline my-tickets keyboard: one button per ticket + page nav with 2 pages', () => {
    const tickets = Array.from({ length: MYT_PAGE_SIZE }, (_, i) => ({
      id: `t${i}`,
      subject: `تیکت شماره ${i + 1}`,
      ticket_number: `TKT-1000${i}`,
    }));
    const kb = myTicketsInlineKeyboard(tickets, 1, 2);
    expect(kb.inline_keyboard).toHaveLength(MYT_PAGE_SIZE + 1); // 5 tickets + nav row
    expect(kb.inline_keyboard[0][0].callback_data).toBe('myt:view:t0');
    expect(kb.inline_keyboard[5]).toEqual([
      { text: 'صفحه ۱ از ۲', callback_data: 'myt:noop' },
      { text: 'بعدی ▶️', callback_data: 'myt:page:2' },
    ]);

    const page2 = myTicketsInlineKeyboard(tickets, 2, 2);
    expect(page2.inline_keyboard[5]).toEqual([
      { text: '◀️ قبلی', callback_data: 'myt:page:1' },
      { text: 'صفحه ۲ از ۲', callback_data: 'myt:noop' },
    ]);
  });

  it('single-page lists get no navigation row', () => {
    const kb = myTicketsInlineKeyboard([{ id: 't1', subject: 'عنوان', ticket_number: 'TKT-1' }], 1, 1);
    expect(kb.inline_keyboard).toHaveLength(1);
  });

  it('§2: the profile-gate keyboard shows ONLY «تکمیل پروفایل»', () => {
    const kb = profileGateKeyboard();
    expect(kb.keyboard.flat().map((b) => b.text)).toEqual(['👤 تکمیل پروفایل']);
  });

  it('§4: the chatbot keyboard shows ONLY the exit button', () => {
    const kb = chatbotKeyboard();
    expect(kb.keyboard.flat().map((b) => b.text)).toEqual(['🔙 بازگشت به منوی اصلی']);
  });

  it('§6: the profile card keyboard = main menu + the edit entry', () => {
    const kb = profileCardKeyboard();
    const texts = kb.keyboard.flat().map((b) => b.text);
    expect(texts.slice(0, 5)).toEqual(mainMenuKeyboard().keyboard.flat().map((b) => b.text));
    expect(texts).toContain('✏️ ویرایش اطلاعات');
  });
});
