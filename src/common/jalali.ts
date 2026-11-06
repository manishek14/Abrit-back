/**
 * Jalali (Persian) calendar formatting for the ticket confirmation and the
 * ticket views — feature requirement §7:
 *   - the REAL creation timestamp of the ticket (never model-generated),
 *   - Jalali date, 24-hour clock, timezone Asia/Tehran (APP_TIMEZONE),
 *   - Persian digits (۱۴۰۵/۰۸/۱۵ — ۱۵:۳۰).
 *
 * Zero new dependencies: Node ships a full ICU, and Intl.DateTimeFormat with
 * `ca-persian` performs the conversion (verified against known anchors:
 * 2024-03-20 → 1403/01/01, 2026-03-21 → 1405/01/01, 2026-11-06 → 1405/08/15).
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/** 0-9 → ۰-۹ (dates and times are always shown in Persian digits). */
export function toPersianDigits(value: string): string {
  return value.replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]);
}

function parts(date: Date, timeZone: string): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
}

function pick(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

export interface JalaliDateTime {
  /** ۱۴۰۵/۰۸/۱۵ */
  date: string;
  /** ۱۵:۳۰ */
  time: string;
}

/**
 * Formats an instant as { Jalali date, 24h time } in the given timezone
 * (defaults to APP_TIMEZONE, i.e. Asia/Tehran). Invalid dates throw —
 * callers always pass freshly loaded entity timestamps.
 */
export function formatJalaliDateTime(date: Date, timeZone = 'Asia/Tehran'): JalaliDateTime {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`formatJalaliDateTime: invalid date: ${String(date)}`);
  }
  const p = parts(date, timeZone);
  return {
    date: toPersianDigits(`${pick(p, 'year')}/${pick(p, 'month')}/${pick(p, 'day')}`),
    time: toPersianDigits(`${pick(p, 'hour')}:${pick(p, 'minute')}`),
  };
}

/** «۱۴۰۵/۰۸/۱۵ — ۱۵:۳۰» convenience for lists and cards. */
export function formatJalaliInline(date: Date, timeZone = 'Asia/Tehran'): string {
  const { date: d, time: t } = formatJalaliDateTime(date, timeZone);
  return `${d} — ${t}`;
}
