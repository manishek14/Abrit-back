import { TicketDepartment } from '../../database/enums';
import { toPersianDigits } from '../../common/jalali';

/**
 * THE single source of truth for every bot keyboard and button label
 * (feature requirement §5): the flow services route incoming text by THESE
 * constants and render keyboards from THESE builders — no duplicated literal
 * strings in handlers, so a label change can never desynchronize routing.
 *
 * Reply keyboards (ReplyKeyboardMarkup) are used everywhere except the
 * my-tickets list, where per-ticket selection + pagination genuinely need
 * inline callback buttons.
 */

export interface ReplyButton {
  text: string;
  request_contact?: boolean;
  web_app?: never;
}

export interface ReplyKeyboard {
  keyboard: ReplyButton[][];
  resize_keyboard: true;
  one_time_keyboard?: boolean;
}

export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export interface RemoveKeyboard {
  remove_keyboard: true;
}

export type BotReplyMarkup = ReplyKeyboard | InlineKeyboard | RemoveKeyboard;

// ── main menu ────────────────────────────────────────────────────────────────
export const BTN_NEW_TICKET = '🎫 ثبت تیکت جدید';
export const BTN_MY_TICKETS = '📋 تیکت‌های من';
export const BTN_TRACK = '🔍 پیگیری تیکت';
export const BTN_PROFILE = '👤 پروفایل من';
export const BTN_HELP = '❓ راهنما';

export function mainMenuKeyboard(): ReplyKeyboard {
  return {
    keyboard: [
      [{ text: BTN_NEW_TICKET }, { text: BTN_MY_TICKETS }],
      [{ text: BTN_TRACK }, { text: BTN_PROFILE }],
      [{ text: BTN_HELP }],
    ],
    resize_keyboard: true,
  };
}

// ── profile gate (request §2) ────────────────────────────────────────────────
export const BTN_COMPLETE_PROFILE = '👤 تکمیل پروفایل';

/**
 * THE gate keyboard: the ONLY reply keyboard a user without a completed
 * profile may ever see after touching a protected feature — one button, no
 * escape into main features (the router enforces the same rule server-side).
 */
export function profileGateKeyboard(): ReplyKeyboard {
  return {
    keyboard: [[{ text: BTN_COMPLETE_PROFILE }]],
    resize_keyboard: true,
  };
}

// ── registration ─────────────────────────────────────────────────────────────
export const BTN_REG_BACK = '🔙 بازگشت';
export const BTN_SHARE_CONTACT = '📱 ارسال شماره همراه من';
export const BTN_EDIT_PROFILE = '✏️ ویرایش اطلاعات';

/** Step 1 (name) takes free text — the keyboard is removed to signal that. */
export function registrationNameKeyboard(): RemoveKeyboard {
  return { remove_keyboard: true };
}

/** Step 2: contact sharing preferred, manual entry stays possible (§1). */
export function registrationPhoneKeyboard(): ReplyKeyboard {
  return {
    keyboard: [[{ text: BTN_SHARE_CONTACT, request_contact: true }], [{ text: BTN_REG_BACK }]],
    resize_keyboard: true,
  };
}

// ── ticket wizard ────────────────────────────────────────────────────────────
export const BTN_CANCEL_TICKET = '❌ لغو ثبت تیکت';
export const BTN_WIZARD_BACK = '🔙 بازگشت';

export function ticketCancelKeyboard(): ReplyKeyboard {
  return {
    keyboard: [[{ text: BTN_CANCEL_TICKET }]],
    resize_keyboard: true,
  };
}

export interface DepartmentOption {
  key: TicketDepartment;
  label: string;
}

/** THE department catalogue — wizard keyboard, input validation and labels. */
export const DEPARTMENTS: DepartmentOption[] = [
  { key: TicketDepartment.FINANCE, label: '💰 مالی' },
  { key: TicketDepartment.SUPPORT, label: '🎧 پشتیبانی' },
  { key: TicketDepartment.TECHNICAL, label: '⚙️ فنی' },
  { key: TicketDepartment.SUGGESTIONS, label: '💡 پیشنهادات و انتقادات' },
];

export const DEPARTMENT_LABELS: Record<TicketDepartment, string> = Object.fromEntries(
  DEPARTMENTS.map((d) => [d.key, d.label]),
) as Record<TicketDepartment, string>;

/** Exact label → enum. Free text can NEVER become a department (§3). */
export function departmentByLabel(label: string): DepartmentOption | null {
  const trimmed = label.trim();
  return DEPARTMENTS.find((d) => d.label === trimmed) ?? null;
}

export function departmentKeyboard(): ReplyKeyboard {
  return {
    keyboard: [
      [{ text: DEPARTMENTS[0].label }, { text: DEPARTMENTS[1].label }],
      [{ text: DEPARTMENTS[2].label }, { text: DEPARTMENTS[3].label }],
      [{ text: BTN_WIZARD_BACK }],
    ],
    resize_keyboard: true,
  };
}

// ── ticket view ──────────────────────────────────────────────────────────────
export const BTN_SEND_MESSAGE = '💬 ارسال پیام';
export const BTN_TICKET_INFO = '📋 اطلاعات تیکت';
export const BTN_BACK_TO_MY_TICKETS = '🔙 بازگشت به تیکت‌های من';

export function ticketViewKeyboard(): ReplyKeyboard {
  return {
    keyboard: [
      [{ text: BTN_SEND_MESSAGE }, { text: BTN_TICKET_INFO }],
      [{ text: BTN_BACK_TO_MY_TICKETS }],
    ],
    resize_keyboard: true,
  };
}

// ── chatbot mode (request §4/§5) ─────────────────────────────────────────────
export const BTN_CHATBOT_EXIT = '🔙 بازگشت به منوی اصلی';

/** Chatbot mode: one exit button — everything else typed here is AI input. */
export function chatbotKeyboard(): ReplyKeyboard {
  return {
    keyboard: [[{ text: BTN_CHATBOT_EXIT }]],
    resize_keyboard: true,
  };
}

/** The /profile card: main menu + the edit entry (edit = re-run registration). */
export function profileCardKeyboard(): ReplyKeyboard {
  const menu = mainMenuKeyboard().keyboard;
  return { keyboard: [...menu, [{ text: BTN_EDIT_PROFILE }]], resize_keyboard: true };
}

// ── my tickets inline list ───────────────────────────────────────────────────
export const MYT_PAGE_SIZE = 5;
export const MYT_CALLBACK_VIEW = 'myt:view:';
export const MYT_CALLBACK_PAGE = 'myt:page:';

/**
 * Inline keyboard for /mytickets: one button per ticket + page navigation.
 * callback_data carries the ticket UUID / target page — self-contained, so
 * pagination needs NO server-side state (no stale-state surface at all).
 */
export function myTicketsInlineKeyboard(
  tickets: { id: string; subject: string | null; ticket_number: string }[],
  page: number,
  totalPages: number,
): InlineKeyboard {
  const rows: InlineKeyboard['inline_keyboard'] = tickets.map((t, i) => [
    {
      text: `${(page - 1) * MYT_PAGE_SIZE + i + 1}. ${truncate(t.subject ?? t.ticket_number, 40)}`,
      callback_data: `${MYT_CALLBACK_VIEW}${t.id}`,
    },
  ]);
  if (totalPages > 1) {
    const nav: InlineKeyboard['inline_keyboard'][number] = [];
    if (page > 1) nav.push({ text: '◀️ قبلی', callback_data: `${MYT_CALLBACK_PAGE}${page - 1}` });
    nav.push({
      text: toPersianDigits(`صفحه ${page} از ${totalPages}`),
      callback_data: 'myt:noop',
    });
    if (page < totalPages) nav.push({ text: 'بعدی ▶️', callback_data: `${MYT_CALLBACK_PAGE}${page + 1}` });
    rows.push(nav);
  }
  return { inline_keyboard: rows };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
