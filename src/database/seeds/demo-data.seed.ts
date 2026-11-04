import { DataSource } from 'typeorm';
import { TelegramUser } from '../entities/telegram-user.entity';
import { Ticket } from '../entities/ticket.entity';
import { Message } from '../entities/message.entity';
import { DeliveryStatus, MessageRole, TicketStatus } from '../enums';

/**
 * Persian demo data — required by the trial assignment ("استفاده از داده آزمایشی
 * الزامی است"). Idempotent: runs only when the users table is empty, so repeated
 * boots never duplicate rows. All bot messages are marked SENT with realistic
 * timestamps so the panel and dashboard demo well without any Telegram token.
 */
export async function seedDemoData(ds: DataSource): Promise<void> {
  const usersRepo = ds.getRepository(TelegramUser);
  if ((await usersRepo.count()) > 0) return;

  const ticketsRepo = ds.getRepository(Ticket);
  const messagesRepo = ds.getRepository(Message);

  const h = (n: number) => new Date(Date.now() - n * 3600_000);

  const sara = await usersRepo.save(
    usersRepo.create({
      telegram_id: '100000001',
      chat_id: '100000001',
      username: 'sara_m',
      first_name: 'سارا',
      last_name: 'محمدی',
      language_code: 'fa',
      created_at: h(80),
      last_seen_at: h(5),
    }),
  );

  const ali = await usersRepo.save(
    usersRepo.create({
      telegram_id: '100000002',
      chat_id: '100000002',
      username: 'ali_rezaei',
      first_name: 'علی',
      last_name: 'رضایی',
      language_code: 'fa',
      created_at: h(30),
      last_seen_at: h(2),
    }),
  );

  const negar = await usersRepo.save(
    usersRepo.create({
      telegram_id: '100000003',
      chat_id: '100000003',
      username: 'negar_k',
      first_name: 'نگار',
      last_name: 'کریمی',
      language_code: 'fa',
      created_at: h(200),
      last_seen_at: h(48),
    }),
  );

  const mk = (ticket_id: string, role: MessageRole, content: string, at: Date, extra: Partial<Message> = {}) =>
    messagesRepo.create({
      ticket_id,
      role,
      content,
      created_at: at,
      delivery_status:
        role === MessageRole.USER ? null : DeliveryStatus.SENT,
      sent_at: role === MessageRole.USER ? null : at,
      ...extra,
    });

  // ── Ticket 1 — OPEN: payment error ─────────────────────────────────────────
  const t1 = await ticketsRepo.save(
    ticketsRepo.create({
      user_id: sara.id,
      status: TicketStatus.OPEN,
      subject: 'خطا در پرداخت سفارش',
      created_at: h(6),
      updated_at: h(2),
      last_message_at: h(2),
    }),
  );
  await messagesRepo.save([
    mk(t1.id, MessageRole.USER, 'سلام، وقتی سفارش می‌دم موقع پرداخت خطای «تراکنش ناموفق» می‌گیرم. سه بار امتحان کردم.', h(6)),
    mk(t1.id, MessageRole.ASSISTANT, 'سلام وقت شما بخیر. متأسفم که با این مشکل روبه‌رو شدید. برای بررسی دقیق‌تر لطفاً شماره سفارش خود را ارسال کنید.', h(6), {
      meta: { model: 'openrouter/auto', latencyMs: 910 },
    }),
    mk(t1.id, MessageRole.USER, 'شماره سفارش من ORD-7842 است.', h(3)),
    mk(t1.id, MessageRole.ASSISTANT, 'ممنون از اطلاعات شما. سفارش شما برای بررسی به تیم مالی ارجاع شد؛ نتیجه حداکثر تا ۲۴ ساعت آینده از همین طریق اعلام می‌شود.', h(2), {
      meta: { model: 'openrouter/auto', latencyMs: 1150 },
    }),
  ]);

  // ── Ticket 2 — IN_PROGRESS: login code not delivered ──────────────────────
  const t2 = await ticketsRepo.save(
    ticketsRepo.create({
      user_id: ali.id,
      status: TicketStatus.IN_PROGRESS,
      subject: 'عدم دریافت کد تایید ورود',
      created_at: h(28),
      updated_at: h(4),
      last_message_at: h(3),
    }),
  );
  await messagesRepo.save([
    mk(t2.id, MessageRole.USER, 'سلام، کد تایید ورود برای من ارسال نمی‌شود؛ شماره‌ام درست است.', h(28)),
    mk(t2.id, MessageRole.ASSISTANT, 'با سلام. برای بررسی وضعیت خط، لطفاً چهار رقم آخر شماره موبایل خود را ارسال کنید.', h(28), {
      meta: { model: 'openrouter/auto', latencyMs: 830 },
    }),
    mk(t2.id, MessageRole.SYSTEM, 'وضعیت تیکت توسط کارشناس پشتیبانی به «در حال بررسی» تغییر کرد.', h(10)),
    mk(t2.id, MessageRole.USER, '۴۴۲۱', h(4)),
    mk(t2.id, MessageRole.ASSISTANT, 'از صبر شما متشکرم. موضوع به واحد فنی ارجاع شد و در حال بررسی است؛ نتیجه از همین تیکت اطلاع داده می‌شود.', h(3), {
      meta: { model: 'openrouter/auto', latencyMs: 1020 },
    }),
  ]);

  // ── Ticket 3 — CLOSED: official invoice request ───────────────────────────
  const t3 = await ticketsRepo.save(
    ticketsRepo.create({
      user_id: negar.id,
      status: TicketStatus.CLOSED,
      subject: 'درخواست فاکتور رسمی',
      created_at: h(200),
      updated_at: h(48),
      last_message_at: h(49),
      closed_at: h(48),
    }),
  );
  await messagesRepo.save([
    mk(t3.id, MessageRole.USER, 'سلام، برای خرید سازمانی به فاکتور رسمی نیاز دارم.', h(200)),
    mk(t3.id, MessageRole.ASSISTANT, 'سلام. حتماً. لطفاً نام شرکت و شناسه ملی را ارسال کنید تا درخواست فاکتور رسمی ثبت شود.', h(200), {
      meta: { model: 'openrouter/auto', latencyMs: 780 },
    }),
    mk(t3.id, MessageRole.USER, 'شرکت فناوران داده، شناسه ملی ۱۴۰۰۹۸۷۶۵۴۳۲', h(52)),
    mk(t3.id, MessageRole.ASSISTANT, 'درخواست شما ثبت شد؛ فاکتور رسمی حداکثر تا ۲ روز کاری به ایمیل سازمانی شما ارسال می‌شود.', h(50), {
      meta: { model: 'openrouter/auto', latencyMs: 890 },
    }),
    mk(t3.id, MessageRole.SYSTEM, 'وضعیت تیکت توسط کارشناس پشتیبانی به «بسته» تغییر کرد.', h(49)),
  ]);
}
