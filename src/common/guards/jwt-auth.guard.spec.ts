import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';

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
});
