import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SESSION_COOKIE_NAME } from '../../modules/auth/session-cookies';

describe('JwtAuthGuard', () => {
  let jwt: { verifyAsync: jest.Mock };
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: JwtAuthGuard;
  let request: { headers: Record<string, string>; admin?: unknown };

  const ctx = {
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => request }),
  } as never as import('@nestjs/common').ExecutionContext;

  beforeEach(() => {
    jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub: 'a-1', email: 'a@b.c', name: 'Admin' }) };
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    request = { headers: {} };
    guard = new JwtAuthGuard(jwt as unknown as JwtService, reflector as unknown as Reflector);
  });

  it('lets @Public routes through without any token', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('rejects a missing Bearer token with 401', async () => {
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a malformed Authorization header with 401', async () => {
    request.headers.authorization = 'Basic abc';
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('attaches the admin payload on a valid token', async () => {
    request.headers.authorization = 'Bearer valid-token';
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(jwt.verifyAsync).toHaveBeenCalledWith('valid-token');
    expect(request.admin).toEqual({ sub: 'a-1', email: 'a@b.c', name: 'Admin' });
  });

  it('rejects an invalid/expired token with 401', async () => {
    request.headers.authorization = 'Bearer expired';
    jwt.verifyAsync.mockRejectedValueOnce(new Error('jwt expired'));
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  // --- review round 6 (P2 session security): the HttpOnly cookie fallback ---

  it('authenticates via the HttpOnly session cookie when no Bearer header is present', async () => {
    request.headers.cookie = `${SESSION_COOKIE_NAME}=cookie-jwt`; // HttpOnly — JS never sees this value
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(jwt.verifyAsync).toHaveBeenCalledWith('cookie-jwt');
    expect(request.admin).toEqual({ sub: 'a-1', email: 'a@b.c', name: 'Admin' });
  });

  it('the Bearer header wins over the session cookie when both are present', async () => {
    request.headers.authorization = 'Bearer header-token';
    request.headers.cookie = `${SESSION_COOKIE_NAME}=cookie-jwt`;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(jwt.verifyAsync).toHaveBeenCalledWith('header-token');
  });

  it('rejects an invalid session cookie with 401', async () => {
    request.headers.cookie = `${SESSION_COOKIE_NAME}=garbage`;
    jwt.verifyAsync.mockRejectedValueOnce(new Error('jwt malformed'));
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('ignores unrelated cookies (no session cookie → 401)', async () => {
    request.headers.cookie = 'other=cookie; abrit_csrf=x';
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });
});
