import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { CurrentAdminPayload } from '../decorators/current-admin.decorator';
import { SESSION_COOKIE_NAME, readCookieHeader } from '../../modules/auth/session-cookies';

/**
 * Global guard: every route requires a valid session EXCEPT those marked
 * @Public() (login, health, telegram webhook — the webhook authenticates via
 * its dedicated Telegram secret header instead).
 *
 * Two credential transports are accepted (review round 6, P2 session security):
 *  1. `Authorization: Bearer <jwt>` — API clients / Swagger,
 *  2. the HttpOnly `abrit_session` cookie — the admin panel (the credential
 *     the browser stores automatically; JavaScript can never read it).
 * The Bearer header wins when both are present.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.authorization;
    const bearerToken = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const cookieToken = readCookieHeader(request.headers?.cookie, SESSION_COOKIE_NAME);
    const token = bearerToken ?? cookieToken;
    if (!token) throw new UnauthorizedException('Missing access token');

    try {
      const payload = await this.jwt.verifyAsync<CurrentAdminPayload>(token);
      request.admin = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
