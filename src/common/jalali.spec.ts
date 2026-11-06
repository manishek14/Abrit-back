import { toPersianDigits, formatJalaliDateTime, formatJalaliInline } from './jalali';

describe('jalali (feature §7 — تاریخ و ساعت شمسی)', () => {
  it('converts Latin digits to Persian digits', () => {
    expect(toPersianDigits('1405/08/15')).toBe('۱۴۰۵/۰۸/۱۵');
    expect(toPersianDigits('15:30')).toBe('۱۵:۳۰');
    expect(toPersianDigits('x9')).toBe('x۹');
  });

  it('formats 2026-11-06 11:30 UTC as ۱۴۰۵/۰۸/۱۵ ۱۵:۰۰ in Tehran (UTC+3:30)', () => {
    const out = formatJalaliDateTime(new Date('2026-11-06T11:30:00Z'));
    expect(out.date).toBe('۱۴۰۵/۰۸/۱۵');
    expect(out.time).toBe('۱۵:۰۰');
  });

  it('matches the spec example (۱۴۰۵/۰۸/۱۵)', () => {
    // the requirement's own sample — the real creation date of a ticket made today
    const out = formatJalaliDateTime(new Date('2026-11-06T08:00:00Z'));
    expect(out.date).toBe('۱۴۰۵/۰۸/۱۵');
  });

  it('lands on the known Nowruz anchors (calendar correctness)', () => {
    // Nowruz 1403 = 2024-03-20, Nowruz 1405 = 2026-03-21 (Iran, no DST since 2022)
    expect(formatJalaliDateTime(new Date('2024-03-20T12:00:00Z')).date).toBe('۱۴۰۳/۰۱/۰۱');
    expect(formatJalaliDateTime(new Date('2026-03-21T12:00:00Z')).date).toBe('۱۴۰۵/۰۱/۰۱');
  });

  it('rolls the Tehran day correctly for UTC times around midnight', () => {
    // 2026-11-06 21:30 UTC = 2026-11-07 01:00 Tehran → Aban 16
    const out = formatJalaliDateTime(new Date('2026-11-06T21:30:00Z'));
    expect(out.date).toBe('۱۴۰۵/۰۸/۱۶');
    expect(out.time).toBe('۰۱:۰۰');
  });

  it('uses 24-hour clock and throws on invalid input', () => {
    expect(formatJalaliDateTime(new Date('2026-06-21T16:00:00Z')).time).toBe('۱۹:۳۰');
    expect(() => formatJalaliDateTime(new Date('nope'))).toThrow();
    expect(() => formatJalaliDateTime(undefined as unknown as Date)).toThrow();
  });

  it('inline format combines both parts', () => {
    expect(formatJalaliInline(new Date('2026-11-06T11:30:00Z'))).toBe('۱۴۰۵/۰۸/۱۵ — ۱۵:۰۰');
  });
});
