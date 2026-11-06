import { Body, Controller, Get, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { randomBytes } from 'crypto';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CsrfExempt } from '../../common/decorators/csrf-exempt.decorator';
import { CurrentAdmin, CurrentAdminPayload } from '../../common/decorators/current-admin.decorator';
import { getEnv } from '../../config/env';
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  clearCookieOptions,
  csrfCookieOptions,
  sessionCookieOptions,
} from './session-cookies';

/** Minimal structural type for Nest's passthrough @Res() — avoids a hard
 *  dependency on @types/express (same pattern as tickets.controller). */
interface CookieResponse {
  cookie(name: string, value: string, options: object): unknown;
  clearCookie(name: string, options?: object): unknown;
}

@Controller('auth')
@ApiTags('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Public + rate-limited (5 attempts/minute per IP).
   *
   * Session security (review round 6, P2): the panel session is an HttpOnly
   * cookie (SameSite=Strict, Secure in production, maxAge = JWT expiry) — the
   * browser stores it, JavaScript can neither read nor steal it. A readable
   * `abrit_csrf` cookie travels alongside for the double-submit CSRF check
   * enforced by the global CsrfGuard.
   *
   * `accessToken` is STILL returned in the body for API clients / Swagger
   * (Bearer stays supported); the panel ignores it.
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: CookieResponse,
  ): Promise<{ accessToken: string; admin: { id: string; email: string; name: string } }> {
    const result = await this.authService.login(dto.email, dto.password);
    const env = getEnv();

    res.cookie(SESSION_COOKIE_NAME, result.accessToken, sessionCookieOptions(env));
    res.cookie(CSRF_COOKIE_NAME, randomBytes(32).toString('hex'), csrfCookieOptions(env));

    return result;
  }

  /**
   * Clears the session. @Public on purpose: an expired/invalid session must
   * still be clearable (the cookie is the only credential left to erase).
   * Exempt from CSRF — clearing a cookie can only log the CALLER out.
   */
  @Public()
  @CsrfExempt()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) res: CookieResponse): { ok: true } {
    const env = getEnv();
    res.clearCookie(SESSION_COOKIE_NAME, clearCookieOptions(env));
    res.clearCookie(CSRF_COOKIE_NAME, clearCookieOptions(env));
    return { ok: true };
  }

  /** Session restore for the panel (HttpOnly cookie → who am I?). */
  @Get('me')
  async me(@CurrentAdmin() admin: CurrentAdminPayload) {
    return { admin: await this.authService.me(admin.sub) };
  }
}
