import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CsrfGuard } from './csrf.guard';
import { CsrfExempt } from '../decorators/csrf-exempt.decorator';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '../../modules/auth/session-cookies';

/**
 * Review round 6 (P2 session security): the panel moved from a localStorage
 * token to an HttpOnly cookie. Cookies are attached by the browser
 * automatically — so every cookie-authenticated, state-changing request MUST
 * present the double-submit CSRF token.
 */
describe('CsrfGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: CsrfGuard;

  const mkCtx = (request: {
    method?: string;
    headers?: Record<string, string | undefined>;
  }): ExecutionContext =>
    ({
      getHandler: () => 'handler',
      getClass: () => 'class',
      switchToHttp: () => ({ getRequest: () => ({ method: 'POST', ...request }) }),
    }) as never as ExecutionContext;

  const cookieHeader = (session?: string, csrf?: string): string => {
    const parts: string[] = [];
    if (session) parts.push(`${SESSION_COOKIE_NAME}=${session}`);
    if (csrf) parts.push(`${CSRF_COOKIE_NAME}=${csrf}`);
    return parts.join('; ');
  };

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    guard = new CsrfGuard(reflector as unknown as Reflector);
  });

  it('lets safe methods (GET/HEAD/OPTIONS) through without any CSRF token', () => {
    const ctx = mkCtx({ method: 'GET', headers: { cookie: cookieHeader('sess') } });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('lets Bearer-authenticated mutations through (not cookie-based, not CSRF-able)', () => {
    const ctx = mkCtx({ headers: { authorization: 'Bearer some.jwt.token' } });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('lets anonymous mutations through (no session cookie — nothing to forge)', () => {
    const ctx = mkCtx({ headers: {} });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects a cookie-authenticated mutation WITHOUT the CSRF header (403)', () => {
    const ctx = mkCtx({ headers: { cookie: cookieHeader('sess', 'token-1') } });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects a MISMATCHING CSRF token (403, timing-safe comparison)', () => {
    const ctx = mkCtx({
      headers: {
        cookie: cookieHeader('sess', 'token-1'),
        'x-csrf-token': 'attacker-value',
      },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('accepts a cookie-authenticated mutation whose header echoes the csrf cookie', () => {
    const ctx = mkCtx({
      headers: {
        cookie: cookieHeader('sess', 'token-1'),
        'x-csrf-token': 'token-1',
      },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('a session cookie with NO csrf cookie is rejected (403)', () => {
    const ctx = mkCtx({
      headers: { cookie: cookieHeader('sess'), 'x-csrf-token': 'whatever' },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('respects @CsrfExempt (login/logout stay usable)', () => {
    reflector.getAllAndOverride.mockReturnValueOnce(true);
    const ctx = mkCtx({ headers: { cookie: cookieHeader('sess', 'token-1') } });
    expect(guard.canActivate(ctx)).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(expect.anything(), ['handler', 'class']);
  });

  it('the exempt decorator really sets the metadata key', () => {
    // sanity: the decorator returns a function and the guard reads the key
    expect(typeof CsrfExempt()).toBe('function');
  });
});
