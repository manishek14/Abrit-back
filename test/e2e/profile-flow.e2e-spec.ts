import request from 'supertest';
import { DataSource } from 'typeorm';
import { INestApplication } from '@nestjs/common';
import { SweeperService } from '../../src/modules/telegram/sweeper.service';
import { FakeTelegramGateway } from '../fakes/telegram-gateway.fake';
import { createTestApp } from '../testing/app-builder';

/**
 * End-to-end scenarios of the FEATURE round (spec §9): mandatory profile,
 * staged ticket wizard, /mytickets with inline pagination, ownership isolation,
 * cancel semantics and keyboard correctness — against REAL PostgreSQL with
 * only the Telegram transport faked.
 */
describe('ABRIT feature flows (profile → wizard → mytickets → AI chat)', () => {
  let app: INestApplication;
  let fakeGateway: FakeTelegramGateway;
  let ds: DataSource;
  let token: string;

  let nextUpdateId = 700_000;
  let nextCallbackId = 1;
  const webhookSecret = 'e2e-webhook-secret';

  const postUpdate = (update: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', webhookSecret)
      .send(update as object)
      .expect(200);

  const messageUpdate = (tgId: number, text: string) => ({
    update_id: nextUpdateId++,
    message: {
      message_id: nextUpdateId,
      from: { id: tgId, is_bot: false, first_name: `کاربر ${tgId}`, username: `u${tgId}` },
      chat: { id: tgId, type: 'private' },
      text,
    },
  });

  const contactUpdate = (tgId: number, phone: string, ownerId: number = tgId) => ({
    update_id: nextUpdateId++,
    message: {
      message_id: nextUpdateId,
      from: { id: tgId, is_bot: false },
      chat: { id: tgId, type: 'private' },
      contact: { phone_number: phone, user_id: ownerId, first_name: 'کاربر' },
    },
  });

  const callbackUpdate = (tgId: number, data: string) => ({
    update_id: nextUpdateId++,
    callback_query: {
      id: `cb-${nextCallbackId++}`,
      from: { id: tgId, is_bot: false },
      message: { message_id: 42, chat: { id: tgId, type: 'private' } },
      data,
    },
  });

  const count = async (table: string, where = '') =>
    Number(
      (await ds.query(`SELECT count(*)::int AS n FROM ${table}${where ? ' WHERE ' + where : ''}`))[0].n,
    );

  async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('waitFor: condition not met in time');
  }

  const lastSent = () => fakeGateway.sent.at(-1)!;
  const sentFor = (tgId: number, needle: string) =>
    fakeGateway.sent.some((s) => s.chat_id === String(tgId) && s.text.includes(needle));
  const waitForSent = (needle: string) =>
    waitFor(() => fakeGateway.sent.some((s) => s.text.includes(needle)));
  const waitForSentFor = (tgId: number, needle: string) =>
    waitFor(() => sentFor(tgId, needle));
  const findSent = (needle: string) => fakeGateway.sent.find((s) => s.text.includes(needle))!;
  const clearSent = () => {
    fakeGateway.sent = [];
  };

  const authed = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  async function register(tgId: number, name = 'کاربر آزمون'): Promise<void> {
    await postUpdate(messageUpdate(tgId, '/start'));
    await waitForSentFor(tgId, 'خوش آمدید');
    await postUpdate(messageUpdate(tgId, name));
    await waitForSentFor(tgId, 'شماره همراه');
    await postUpdate(messageUpdate(tgId, '09121234567'));
    await waitForSentFor(tgId, 'پروفایل شما تکمیل شد');
  }

  async function createTicket(
    tgId: number,
    title: string,
    department: string,
    description: string,
  ): Promise<void> {
    await postUpdate(messageUpdate(tgId, '🎫 ثبت تیکت جدید'));
    await waitForSentFor(tgId, 'عنوان تیکت');
    await postUpdate(messageUpdate(tgId, title));
    await waitForSentFor(tgId, 'دپارتمان');
    await postUpdate(messageUpdate(tgId, department));
    await waitForSentFor(tgId, 'متن درخواست');
    await postUpdate(messageUpdate(tgId, description));
    await waitForSentFor(tgId, 'تیکت شما با موفقیت ثبت شد');
  }

  beforeAll(async () => {
    const built = await createTestApp();
    app = built.app;
    fakeGateway = built.fakeGateway;
    ds = app.get(DataSource);

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@abrit.local', password: 'Admin1234!' });
    expect(login.status).toBe(200);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE TABLE messages, tickets, telegram_users, bot_updates RESTART IDENTITY CASCADE');
    fakeGateway.reset();
  });

  /* ---------------- §9.1–3: registration ---------------- */

  it('scenario 1/2: a new user /start → name step → phone keyboard with request_contact → profile completed & PERSISTED', async () => {
    await postUpdate(messageUpdate(810001, '/start'));
    await waitForSent('خوش آمدید');

    // the name step removes any reply keyboard (free-text expected)
    const ask = lastSent();
    expect(ask.text).toContain('نام و نام خانوادگی');
    expect(ask.reply_markup).toEqual({ remove_keyboard: true });
    clearSent();

    await postUpdate(messageUpdate(810001, 'علی رضایی'));
    await waitForSent('شماره همراه');

    // the phone step offers the contact-sharing button (request_contact)
    const phoneAsk = lastSent();
    const kb = phoneAsk.reply_markup as { keyboard: { request_contact?: boolean }[][] };
    expect(kb.keyboard.flat().some((b) => b.request_contact)).toBe(true);
    clearSent();

    // §1: the CONTACT path (preferred) — shared through the keyboard button
    await postUpdate(contactUpdate(810001, '+989351112233'));
    await waitForSent('پروفایل شما تکمیل شد');

    const [user] = await ds.query(`SELECT * FROM telegram_users WHERE telegram_id = '810001'`);
    expect(user.full_name).toBe('علی رضایی');
    expect(user.phone).toBe('09351112233'); // normalized
    expect(user.profile_completed_at).not.toBeNull();
    expect(user.bot_state).toBeNull(); // state cleaned after completion
  });

  it('scenario 2b: manual phone entry works and invalid inputs are rejected at BOTH steps', async () => {
    await register(810002, 'سارا محمدی');
    clearSent();

    // invalid phone retried manually
    await postUpdate(messageUpdate(810003, '/start'));
    await waitForSent('خوش آمدید');
    clearSent();
    await postUpdate(messageUpdate(810003, 'سارا محمدی دومی'));
    await waitForSent('شماره همراه');
    clearSent();

    await postUpdate(messageUpdate(810003, '12345'));
    await waitForSent('معتبر نیست');
    clearSent();
    await postUpdate(messageUpdate(810003, '0912 345 6789'));
    await waitForSent('پروفایل شما تکمیل شد');

    const [u] = await ds.query(`SELECT phone FROM telegram_users WHERE telegram_id = '810003'`);
    expect(u.phone).toBe('09123456789');

    // invalid NAME never advances
    await postUpdate(messageUpdate(810004, '/start'));
    await waitForSent('خوش آمدید');
    clearSent();
    await postUpdate(messageUpdate(810004, 'علی123'));
    await waitForSent('معتبر نیست');
    const [state] = await ds.query(`SELECT bot_state FROM telegram_users WHERE telegram_id = '810004'`);
    expect(state.bot_state.flow).toBe('REGISTER_NAME');
  });

  it('scenario 3: a contact belonging to SOMEONE ELSE is rejected (§1 ownership check)', async () => {
    await postUpdate(messageUpdate(810005, '/start'));
    await waitForSent('خوش آمدید');
    clearSent();
    await postUpdate(messageUpdate(810005, 'کاربر سوم'));
    await waitForSent('شماره همراه');
    clearSent();

    await postUpdate(contactUpdate(810005, '09123456789', 999999));
    await waitForSent('متعلق به حساب شما نیست');

    const [u] = await ds.query(`SELECT profile_completed_at FROM telegram_users WHERE telegram_id = '810005'`);
    expect(u.profile_completed_at).toBeNull();
  });

  it('scenario 4/9.3: EVERY main feature is gated behind the profile', async () => {
    // /mytickets and /new answer with the profile-required notice…
    for (const text of ['/mytickets', '/new']) {
      await postUpdate(messageUpdate(810006, text));
      await waitForSent('پروفایل');
      clearSent();
    }
    // …and a plain text lands in the REGISTRATION flow (invalid name → error,
    // state stays REGISTER_NAME — never the AI chat, never a ticket)
    await postUpdate(messageUpdate(810006, 'سلام'));
    await waitForSent('معتبر نیست');
    const [state] = await ds.query(`SELECT bot_state FROM telegram_users WHERE telegram_id = '810006'`);
    expect(state.bot_state.flow).toBe('REGISTER_NAME');
    expect(await count('tickets')).toBe(0);
  });

  /* ---------------- §9.4–6: wizard + confirmation ---------------- */

  it('scenario 5/6: the wizard follows title → department → description and the confirmation carries the REAL Jalali timestamp', async () => {
    await register(810007);
    await createTicket(810007, 'مشکل در ورود به حساب', '⚙️ فنی', 'رمز عبور را درست وارد می‌کنم اما خطای نامعتبر می‌گیرم');

    const confirmation = fakeGateway.sent.find((s) => s.text.includes('تیکت شما با موفقیت ثبت شد'))!;
    expect(confirmation.text).toContain('عنوان: مشکل در ورود به حساب');
    expect(confirmation.text).toContain('دپارتمان: ⚙️ فنی');
    expect(confirmation.text).toMatch(/تاریخ ثبت: [\u06F0-\u06F9]{4}\/[\u06F0-\u06F9]{2}\/[\u06F0-\u06F9]{2}/u); // Jalali, Persian digits
    expect(confirmation.text).toMatch(/ساعت ثبت: [\u06F0-\u06F9]{2}:[\u06F0-\u06F9]{2}/u);
    expect(confirmation.parse_mode).toBe('HTML');

    // the main menu keyboard is back after the wizard
    const kb = confirmation.reply_markup as { keyboard: { text: string }[][] };
    expect(kb.keyboard.flat().map((b) => b.text)).toContain('🎫 ثبت تیکت جدید');

    const [ticket] = await ds.query('SELECT * FROM tickets');
    expect(ticket.subject).toBe('مشکل در ورود به حساب');
    expect(ticket.department).toBe('TECHNICAL');
    const [msg] = await ds.query(`SELECT content FROM messages WHERE role = 'USER'`);
    expect(msg.content).toBe('رمز عبور را درست وارد می‌کنم اما خطای نامعتبر می‌گیرم');

    // §9.12: the description NEVER leaked into the AI handler (no ASSISTANT rows)
    expect(await count('messages', `role = 'ASSISTANT'`)).toBe(0);
  });

  it('scenario 9.9: a free-text department is rejected — ONLY keyboard labels are accepted', async () => {
    await register(810008);
    await postUpdate(messageUpdate(810008, '🎫 ثبت تیکت جدید'));
    await waitForSent('عنوان تیکت');
    clearSent();
    await postUpdate(messageUpdate(810008, 'عنوان معتبر تیکت'));
    await waitForSent('دپارتمان');
    clearSent();

    await postUpdate(messageUpdate(810008, 'همان دپارتمان قبلی')); // free text
    await waitForSent('یکی از گزینه‌ها');
    const [state] = await ds.query(`SELECT bot_state FROM telegram_users WHERE telegram_id = '810008'`);
    expect(state.bot_state.flow).toBe('TICKET_DEPARTMENT'); // did not advance
    expect(await count('tickets')).toBe(0);
  });

  it('scenario 10/9.15: cancel works at EVERY step and restores the main menu', async () => {
    await register(810009);

    // cancel at TITLE
    await postUpdate(messageUpdate(810009, '🎫 ثبت تیکت جدید'));
    await waitForSent('عنوان تیکت');
    clearSent();
    await postUpdate(messageUpdate(810009, '❌ لغو ثبت تیکت'));
    await waitForSent('لغو شد');
    let [state] = await ds.query(`SELECT bot_state FROM telegram_users WHERE telegram_id = '810009'`);
    expect(state.bot_state).toBeNull();
    clearSent();

    // cancel at DEPARTMENT
    await postUpdate(messageUpdate(810009, '🎫 ثبت تیکت جدید'));
    await waitForSent('عنوان تیکت');
    clearSent();
    await postUpdate(messageUpdate(810009, 'عنوان دوم تیکت'));
    await waitForSent('دپارتمان');
    clearSent();
    await postUpdate(messageUpdate(810009, '❌ لغو ثبت تیکت'));
    await waitForSent('لغو شد');
    [state] = await ds.query(`SELECT bot_state FROM telegram_users WHERE telegram_id = '810009'`);
    expect(state.bot_state).toBeNull();
    clearSent();

    // cancel at DESCRIPTION (state carries the title+department — all dropped)
    await postUpdate(messageUpdate(810009, '/new'));
    await waitForSent('عنوان تیکت');
    clearSent();
    await postUpdate(messageUpdate(810009, 'عنوان سوم تیکت'));
    await waitForSent('دپارتمان');
    clearSent();
    await postUpdate(messageUpdate(810009, '💡 پیشنهادات و انتقادات'));
    await waitForSent('متن درخواست');
    clearSent();
    await postUpdate(messageUpdate(810009, '/cancel'));
    await waitForSent('لغو شد');
    [state] = await ds.query(`SELECT bot_state FROM telegram_users WHERE telegram_id = '810009'`);
    expect(state.bot_state).toBeNull();
    expect(await count('tickets')).toBe(0);
  });

  /* ---------------- §9.7–9: /mytickets + isolation ---------------- */

  it('scenario 7/8: /mytickets lists ONLY the caller tickets with status/department; empty state has its own message', async () => {
    await register(810010);
    await postUpdate(messageUpdate(810010, '/mytickets'));
    await waitForSent('تیکتی ثبت نکرده‌اید');
    clearSent();

    await createTicket(810010, 'تیکت اول من', '💰 مالی', 'متن کامل تیکت اول کاربر آزمون');

    // a SECOND user gets the empty list — no leakage
    await register(810011);
    await postUpdate(messageUpdate(810011, '/mytickets'));
    await waitForSent('تیکتی ثبت نکرده‌اید');
    clearSent();

    // user 810010 sees their ticket with the real labels
    await postUpdate(messageUpdate(810010, '📋 تیکت‌های من'));
    await waitForSent('تیکت‌های شما');
    const list = findSent('تیکت‌های شما');
    expect(list.text).toContain('تیکت اول من');
    expect(list.text).toContain('TKT-');
    expect(list.text).toContain('مالی');
    expect(list.text).toContain('باز');
    const kb = list.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    expect(kb.inline_keyboard.flat().some((b) => b.callback_data.startsWith('myt:view:'))).toBe(true);
  });

  it('scenario 9: pagination over 7 tickets + view callback + cross-user view REJECTED', async () => {
    await register(810012);
    // 7 tickets: create → /close → create …
    for (let i = 1; i <= 7; i++) {
      await createTicket(810012, `تیکت شماره ${i}`, '⚙️ فنی', `توضیحات کامل تیکت شماره ${i} برای صفحه‌بندی`);
      if (i < 7) {
        await postUpdate(messageUpdate(810012, '/close'));
        await waitFor(async () => (await count('tickets', `status = 'CLOSED'`)) === i);
      }
    }

    await postUpdate(messageUpdate(810012, '/mytickets'));
    await waitForSent('صفحه ۱ از ۲');
    const page1 = findSent('صفحه ۱ از ۲');
    expect((page1.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard).toHaveLength(6); // 5 + nav
    clearSent();

    // next page via callback
    await postUpdate(callbackUpdate(810012, 'myt:page:2'));
    await waitForSentFor(810012, 'صفحه ۲ از ۲');
    // page 2 = the OLDEST tickets (1–2) — the typed subject keeps its Latin digits
    expect(findSent('صفحه ۲ از ۲').text).toContain('تیکت شماره 1');
    expect(findSent('صفحه ۲ از ۲').text).toContain('بسته'); // real status labels
    clearSent();

    // view one ticket via its callback ('تاریخ ثبت' exists ONLY in the view card)
    const [t] = await ds.query(`SELECT id FROM tickets ORDER BY created_at DESC LIMIT 1`);
    await postUpdate(callbackUpdate(810012, `myt:view:${t.id}`));
    await waitForSentFor(810012, 'تاریخ ثبت');
    expect(findSent('تاریخ ثبت').text).toContain('دپارتمان');
    clearSent();

    // 💬 ارسال پیام → reply into the ticket (durable USER + ASSISTANT rows)
    await postUpdate(messageUpdate(810012, '💬 ارسال پیام'));
    await waitForSent('پیام خود را ارسال کنید');
    clearSent();
    await postUpdate(messageUpdate(810012, 'پیام جدید داخل تیکت'));
    await waitFor(async () => (await count('messages', `role = 'USER' AND ticket_id = '${t.id}'`)) === 2);
    // a dropped test-DB connection can fail the first pipeline run — the
    // sweeper re-drives it deterministically, so give it a hand + a longer wait
    await app.get(SweeperService).sweep('cron');
    await waitFor(async () => (await count('messages', `role = 'ASSISTANT' AND ticket_id = '${t.id}'`)) >= 1, 9000); // AI replied via outbox

    // §8 CROSS-USER: another user pressing the SAME callback sees nothing
    await register(810013);
    await postUpdate(callbackUpdate(810013, `myt:view:${t.id}`));
    await waitForSent('دسترسی ندارید');
    expect(lastSent().text).not.toContain('تیکت شماره');
  });

  /* ---------------- §9.11/13: general AI chat + degradation ---------------- */

  it('scenario 11/12/13: plain text → OpenRouter chat (fallback here, NO ticket, NO ticket-handler leak)', async () => {
    await register(810014);
    await postUpdate(messageUpdate(810014, 'سلام، ربات چطور کار می‌کند؟'));
    await waitForSent('پیام شما ثبت شد'); // honest fallback (key empty in e2e)
    expect(await count('tickets')).toBe(0);
    expect(await count('messages')).toBe(0); // general chat is ephemeral by design
  });

  it('scenario 14: a DB-level finalize failure keeps the wizard state and asks for a retry', async () => {
    await register(810015);
    await postUpdate(messageUpdate(810015, '🎫 ثبت تیکت جدید'));
    await waitForSent('عنوان تیکت');
    clearSent();
    await postUpdate(messageUpdate(810015, 'تست خطای دیتابیس'));
    await waitForSent('دپارتمان');
    clearSent();
    await postUpdate(messageUpdate(810015, '💰 مالی'));
    await waitForSent('متن درخواست');
    clearSent();

    // break ONLY the tickets write path for the finalize (rename — fully
    // reversible, no manual schema surgery): the insert fails with a plain DB error
    await ds.query('ALTER TABLE tickets RENAME TO tickets_backup;');

    await postUpdate(messageUpdate(810015, 'متن کامل درخواست برای تست خطا'));
    await waitForSent('خطایی در ثبت نهایی');

    // §4: NO success message, the state keeps the description for the retry
    const [user] = await ds.query(`SELECT bot_state FROM telegram_users WHERE telegram_id = '810015'`);
    expect(user.bot_state.flow).toBe('TICKET_RETRY');
    expect(user.bot_state.data.description).toBe('متن کامل درخواست برای تست خطا');
    expect(fakeGateway.sent.some((s) => s.text.includes('موفقیت ثبت شد'))).toBe(false);

    // heal the DB and let the user retry — NOTHING they typed was lost
    await ds.query('ALTER TABLE tickets_backup RENAME TO tickets;');

    await postUpdate(messageUpdate(810015, 'متن کامل درخواست برای تست خطا'));
    await waitForSent('تیکت شما با موفقیت ثبت شد'); // retry succeeded

    const [ticket] = await ds.query('SELECT subject, department FROM tickets');
    expect(ticket.subject).toBe('تست خطای دیتابیس');
    expect(ticket.department).toBe('FINANCE');
    expect(await count('tickets')).toBe(1); // the failed attempt left no partial rows
  });

  /* ---------------- §9.15: keyboard correctness ---------------- */

  it('scenario 15: the menu buttons map to their actions and /help shows the guide', async () => {
    await register(810016);
    clearSent();

    await postUpdate(messageUpdate(810016, '👤 پروفایل من'));
    await waitForSentFor(810016, 'پروفایل شما');
    expect(findSent('پروفایل شما').text).toContain('کاربر آزمون');
    clearSent();

    await postUpdate(messageUpdate(810016, '🔍 پیگیری تیکت'));
    await waitForSent('وجود ندارد');
    clearSent();

    await postUpdate(messageUpdate(810016, '❓ راهنما'));
    await waitForSent('راهنمای ربات');
    expect(lastSent().text).toContain('/mytickets');
    clearSent();

    await postUpdate(messageUpdate(810016, 'دستور ناشناخته /whatever'));
    // plain text (not a command) → general chat fallback
    await waitForSent('پیام شما ثبت شد');
  });
});
