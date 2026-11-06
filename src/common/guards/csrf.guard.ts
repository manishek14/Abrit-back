import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'crypto';
import { CSRF_EXEMPT_KEY } from '../decorators/csrf-exempt.decorator';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  readCookieHeader,
} from '../../modules/auth/session-cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF protection (review round 6, P2) — applies ONLY to
 * cookie-authenticated, state-changing requests:
 *
 *  - Bearer-token requests are exempt: browsers never attach an Authorization
 *    header to a forged cross-site form/fetch, so they are not CSRF-able.
 *  - Requests WITHOUT a session cookie are exempt (nothing to forge).
 *  - Everything else must echo the readable `abrit_csrf` cookie in the
 *    X-CSRF-Token header; the comparison is timing-safe.
 *  - SameSite=Strict is the second, independent layer.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.isExempt(context)) return true;

    const request = context.switchToHttp().getRequest();
    const method: string = request.method?.toUpperCase() ?? 'GET';
    if (SAFE_METHODS.has(method)) return true;

    // An Authorization header means the caller is NOT cookie-authenticated.
    const header: string | undefined = request.headers?.authorization;
    if (typeof header === 'string' && header.length > 0) return true;

    const sessionCookie = readCookieHeader(request.headers?.cookie, SESSION_COOKIE_NAME);
    if (!sessionCookie) return true; // anonymous (public routes) — nothing to protect

    const headerToken = request.headers?.[CSRF_HEADER_NAME];
    const cookieToken = readCookieHeader(request.headers?.cookie, CSRF_COOKIE_NAME);
    if (
      typeof headerToken !== 'string' ||
      typeof cookieToken !== 'string' ||
      !timingSafeEqualStr(headerToken, cookieToken)
    ) {
      throw new ForbiddenException('CSRF token missing or invalid');
    }
    return true;
  }

  private isExempt(context: ExecutionContext): boolean {
    return this.reflector.getAllAndOverride<boolean>(CSRF_EXEMPT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
  }
}

/** timingSafeEqual requires equal-length buffers — compare SHA-256 digests so
 *  the length never leaks and arbitrary attacker input stays safe. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}
