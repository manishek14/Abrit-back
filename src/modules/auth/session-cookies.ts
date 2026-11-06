import type { Env } from '../../config/env';

/**
 * Session security (review round 6, P2): the admin panel authenticates with an
 * HttpOnly cookie instead of a localStorage token — JavaScript (and therefore
 * a successful XSS) can no longer read or exfiltrate the session credential.
 *
 *  - `abrit_session`  HttpOnly, SameSite=Strict, Secure in production,
 *                     maxAge mirrors JWT_EXPIRES_IN. Sent automatically by
 *                     the browser; verified by the JWT guard.
 *  - `abrit_csrf`     readable (NOT HttpOnly), SameSite=Strict, Secure in
 *                     production. Double-submit CSRF token: state-changing
 *                     cookie-authenticated requests must echo it in the
 *                     X-CSRF-Token header (checked by CsrfGuard). Bearer
 *                     requests are exempt (an attacker cannot forge custom
 *                     cross-site headers), so Swagger/API clients keep working.
 *
 * SameSite=Strict additionally means a cross-site navigation never carries the
 * cookie at all — the second, independent CSRF layer.
 */

export const SESSION_COOKIE_NAME = 'abrit_session';
export const CSRF_COOKIE_NAME = 'abrit_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

/** Mirrors the JSON Web Token signOptions (jsonwebtoken): `\d+` = ms,
 *  `\d+s|m|h|d` = seconds/minutes/hours/days. The env schema refuses anything
 *  else, so this parser is total. */
export function parseJwtExpiryToMs(value: string): number {
  const match = /^(\d+)([smhd]?)$/.exec(value.trim());
  if (!match) return 8 * 60 * 60 * 1000; // unreachable — schema validates the shape
  const amount = Number(match[1]);
  const unitMs =
    match[2] === 'h'
      ? 3_600_000
      : match[2] === 'm'
        ? 60_000
        : match[2] === 'd'
          ? 86_400_000
          : match[2] === 's'
            ? 1_000
            : 1; // bare number = milliseconds (jsonwebtoken semantics)
  return amount * unitMs;
}

/** `Secure` in production (HTTPS is mandatory there — see docs/DEPLOYMENT.md). */
export function isCookieSecure(env: Env): boolean {
  return env.COOKIE_SECURE ?? env.NODE_ENV === 'production';
}

export interface CookieOptions {
  httpOnly: boolean;
  sameSite: 'strict';
  secure: boolean;
  maxAge: number;
  path: '/';
}

export function sessionCookieOptions(env: Env): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: isCookieSecure(env),
    maxAge: parseJwtExpiryToMs(env.JWT_EXPIRES_IN),
    path: '/',
  };
}

export function csrfCookieOptions(env: Env): CookieOptions {
  return {
    httpOnly: false, // the panel must READ it to echo it in the CSRF header
    sameSite: 'strict',
    secure: isCookieSecure(env),
    maxAge: parseJwtExpiryToMs(env.JWT_EXPIRES_IN),
    path: '/',
  };
}

/** clearCookie must match the set options (minus maxAge/httpOnly semantics). */
export function clearCookieOptions(env: Env): Omit<CookieOptions, 'maxAge' | 'httpOnly'> {
  return { sameSite: 'strict', secure: isCookieSecure(env), path: '/' };
}

/** Reads a value from a raw `Cookie:` header — no cookie-parser dependency. */
export function readCookieHeader(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
