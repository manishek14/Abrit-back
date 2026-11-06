import { Ticket } from '../database/entities/ticket.entity';
import { DEPARTMENT_LABELS } from '../modules/telegram/keyboards';
import { TICKET_STATUS_LABELS } from './ticket-labels';
import { formatJalaliDateTime } from './jalali';

/**
 * Bot copy (feature round) — every staged-flow prompt and the final ticket
 * confirmation live HERE so the flows stay template-driven (requirement §6:
 * staged replies and the final confirmation NEVER come from the AI model).
 */

// ── registration (§1) ────────────────────────────────────────────────────────
export const REG_WELCOME =
  'سلام! به ABRIT خوش آمدید.\n\n' +
  'برای شروع، لطفاً نام و نام خانوادگی خود را وارد کنید.';

export const REG_ASK_PHONE = 'لطفاً شماره همراه خود را ارسال کنید.';

export const REG_NAME_INVALID =
  'نام واردشده معتبر نیست. لطفاً نام و نام خانوادگی واقعی خود را وارد کنید (حداقل دو بخش، فقط حروف).';

export const REG_NAME_TOO_LONG = 'نام واردشده بیش از حد طولانی است (حداکثر ۱۲۰ کاراکتر).';

export const REG_PHONE_INVALID =
  'شماره همراه واردشده معتبر نیست. لطفاً شماره موبایل ایرانی را با یکی از این قالب‌ها ارسال کنید:\n۰۹۱۲۳۴۵۶۷۸۹ یا +989123456789';

export const REG_CONTACT_OWNER_MISMATCH =
  'شماره ارسالی متعلق به حساب شما نیست. لطفاً از دکمه «📱 ارسال شماره همراه من» استفاده کنید یا شماره خود را تایپ کنید.';

export const REG_DONE =
  '✅ پروفایل شما تکمیل شد!\n\nاز این پس می‌توانید از تمام امکانات ربات استفاده کنید.';

export const REG_REQUIRED =
  'برای استفاده از امکانات ربات ابتدا باید پروفایل خود را تکمیل کنید.';

export const GENERIC_CANCELED = 'عملیات جاری لغو شد.';

// ── chatbot mode (request §4/§5) ─────────────────────────────────────────────
export const CHATBOT_INTRO =
  'به دستیار هوشمند ABRIT خوش آمدید. سؤال خود را ارسال کنید.';

/** The EXACT waiting text required by request §5 — sent BEFORE OpenRouter. */
export const CHATBOT_WAITING =
  'Chatbot is working on your request. Please wait a moment.';

export const CHATBOT_ERROR =
  '⚠️ متأسفانه در پردازش درخواست شما خطایی رخ داد. لطفاً دوباره سؤال خود را ارسال کنید.';

export const CHATBOT_LEFT =
  'از حالت گفت‌وگو با دستیار هوشمند خارج شدید. از منوی زیر انتخاب کنید.';

/** Telegram hard limit for one message — long AI answers are split (§5). */
export const TELEGRAM_MESSAGE_MAX_CHARS = 4096;

// ── profile / track ──────────────────────────────────────────────────────────
/**
 * The /profile card (request §6): EXACTLY نام و نام خانوادگی + شماره همراه —
 * the Telegram username is deliberately NOT part of the user-facing profile
 * model (it stays a technical column for the admin panel only).
 */
export function profileCard(user: {
  full_name: string | null;
  phone: string | null;
}): string {
  return [
    '👤 پروفایل شما',
    '',
    `نام و نام خانوادگی: ${user.full_name ?? '—'}`,
    `شماره همراه: ${user.phone ?? '—'}`,
  ].join('\n');
}

export const TRACK_NO_TICKET =
  'تیکتی برای نمایش وجود ندارد. برای ثبت تیکت جدید دکمه «🎫 ثبت تیکت جدید» را بزنید.';

export function trackNoTicket(): string {
  return TRACK_NO_TICKET;
}

/** Help text — the commands + the menu buttons (shown with the main menu). */
export function helpText(): string {
  return [
    '❓ راهنمای ربات ABRIT',
    '',
    'دستور‌ها:',
    '/new — ثبت تیکت جدید',
    '/mytickets — تیکت‌های من',
    '/profile — پروفایل من',
    '/status — پیگیری تیکت',
    '/close — بستن تیکت فعال',
    '/cancel — لغو فرایند جاری',
    '/chatbot — گفت‌وگو با دستیار هوشمند',
    '/help — همین راهنما',
    '',
    'دکمه‌های منوی اصلی:',
    '🎫 ثبت تیکت جدید — فرایند مرحله‌ای ثبت تیکت',
    '📋 تیکت‌های من — مشاهده و پیگیری تیکت‌ها',
    '🔍 پیگیری تیکت — وضعیت آخرین تیکت',
    '👤 پروفایل من — اطلاعات پروفایل',
    '',
    'برای گفت‌وگو با دستیار هوشمند ABRIT دستور /chatbot را بزنید.',
  ].join('\n');
}

export function trackCard(ticket: Ticket): string {
  return [
    `🔍 تیکت ${ticket.ticket_number}`,
    `عنوان: ${ticket.subject ?? '—'}`,
    `دپارتمان: ${ticket.department ? DEPARTMENT_LABELS[ticket.department] : '—'}`,
    `وضعیت: ${TICKET_STATUS_LABELS[ticket.status]}`,
  ].join('\n');
}

// ── ticket wizard (§3) ───────────────────────────────────────────────────────
export const ASK_TITLE = '📝 لطفاً عنوان تیکت خود را وارد کنید.';
export const ASK_DEPARTMENT = '🏢 لطفاً دپارتمان موردنظر خود را انتخاب کنید.';
export const ASK_DESCRIPTION = '💬 لطفاً متن درخواست خود را با جزئیات وارد کنید.';

export const TITLE_INVALID =
  'عنوان تیکت معتبر نیست. لطفاً عنوانی بین ۳ تا ۱۲۰ کاراکتر وارد کنید.';

export const DEPARTMENT_INVALID =
  'لطفاً یکی از گزینه‌های روی کیبورد را انتخاب کنید.';

export const DESCRIPTION_INVALID =
  'متن درخواست معتبر نیست. لطفاً توضیحات را بین ۱۰ تا ۳۰۰۰ کاراکتر وارد کنید.';

export const TICKET_ACTIVE_EXISTS = (ticketNumber: string) =>
  `شما یک تیکت فعال دارید (${ticketNumber}).\n\nبرای پیگیری آن «📋 تیکت‌های من» را باز کنید؛ پس از بسته‌شدن آن می‌توانید تیکت جدید ثبت کنید.`;

export const WIZARD_CANCELED = 'فرایند ثبت تیکت لغو شد.';

/** §3 — the exact confirmation template (HTML, title/department escaped). */
export function ticketConfirmationMessage(ticket: Ticket, createdAt: Date): string {
  const { date, time } = formatJalaliDateTime(createdAt);
  const title = escapeHtml(ticket.subject ?? ticket.ticket_number);
  const department = ticket.department ? escapeHtml(DEPARTMENT_LABELS[ticket.department]) : '—';
  return (
    '🎫 <b>تیکت شما با موفقیت ثبت شد.</b>\n\n' +
    `عنوان: ${title}\n` +
    `دپارتمان: ${department}\n` +
    `تاریخ ثبت: ${date}\n` +
    `ساعت ثبت: ${time}\n\n` +
    'با احترام،\n' +
    'درخواست شما به واحد مربوطه ارجاع داده شد و در حال پیگیری است. کارشناسان ما در اولین فرصت پاسخ خواهند داد.\n\n' +
    '<b>هوش مصنوعی ABRIT</b>'
  );
}

/** HTML parse-mode safety: user-supplied text can never inject markup. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const TICKET_RETRY_FAILED =
  '⚠️ خطایی در ثبت نهایی تیکت رخ داد. اطلاعات شما ذخیره شده است — برای تلاش مجدد دوباره پیام بفرستید یا «❌ لغو ثبت تیکت» را بزنید.';

// ── my tickets (§2) ──────────────────────────────────────────────────────────
export const MY_TICKETS_EMPTY =
  'شما هنوز تیکتی ثبت نکرده‌اید.\n\nبرای شروع دکمه «🎫 ثبت تیکت جدید» را بزنید.';

export function myTicketsHeader(page: number, totalPages: number, total: number): string {
  return `🎫 تیکت‌های شما\n(صفحه ${toFa(page)} از ${toFa(totalPages)} — مجموع ${toFa(total)})`;
}

export function myTicketsLine(index: number, ticket: Ticket): string {
  return [
    `${toFa(index)}. ${ticket.subject ?? ticket.ticket_number}`,
    `   شماره: ${ticket.ticket_number}`,
    `   واحد: ${ticket.department ? DEPARTMENT_LABELS[ticket.department] : '—'}`,
    `   وضعیت: ${TICKET_STATUS_LABELS[ticket.status]}`,
  ].join('\n');
}

export const TICKET_NOT_FOUND = 'تیکت موردنظر پیدا نشد.';
export const TICKET_FORBIDDEN = 'به این تیکت دسترسی ندارید.';
export const TICKET_CLOSED_FOR_REPLY =
  'این تیکت بسته شده است و امکان ارسال پیام جدید ندارد. برای موضوع جدید از «🎫 ثبت تیکت جدید» استفاده کنید.';
export const REPLY_ASK = '💬 پیام خود را ارسال کنید (به کارشناسان همین تیکت ارسال می‌شود).';

function toFa(n: number): string {
  return String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}
