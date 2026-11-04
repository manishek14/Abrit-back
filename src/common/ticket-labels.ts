import { TicketStatus } from '../database/enums';

/** Persian labels used in Telegram notifications and panel badges. */
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: 'باز',
  IN_PROGRESS: 'در حال بررسی',
  CLOSED: 'بسته',
};

export const ONLY_TEXT_SUPPORTED_MESSAGE =
  'فعلاً فقط پیام متنی پشتیبانی می‌شود. لطفاً درخواست خود را به صورت متن ارسال کنید.';

export const MESSAGE_TOO_LONG_MESSAGE =
  'پیام شما بیش از حد طولانی است (حداکثر ۳۰۰۰ کاراکتر). لطفاً آن را کوتاه‌تر کنید.';

export const AI_FALLBACK_MESSAGE =
  'پیام شما ثبت شد و کارشناسان ما به‌زودی پیگیری می‌کنند.';

export const AI_INACTIVE_MESSAGE =
  'پیام شما ثبت شد. دستیار هوشمند در حال حاضر غیرفعال است.';
