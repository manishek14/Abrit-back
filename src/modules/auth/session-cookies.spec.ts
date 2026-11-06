import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  clearCookieOptions,
  csrfCookieOptions,
  isCookieSecure,
  parseJwtExpiryToMs,
  readCookieHeader,
  sessionCookieOptions,
} from './session-cookies';
import { parseEnv } from '../../config/env';
import { setTestEnv } from '../../common/testing/test-env';

const mkEnv = (over: Record<string, string> = {}) =>
  parseEnv({
    DATABASE_URL: 'postgres://abrit@127.0.0.1:5432/abrit',
    JWT_SECRET: 'unit-test-secret-value-0123456789',
    ...over,
  } as Record<string, string>);

describe('session cookies (round 6 P2: HttpOnly session + CSRF double submit)', () => {
  describe('parseJwtExpiryToMs', () => {
    it('parses the unit formats jsonwebtoken accepts', () => {
      expect(parseJwtExpiryToMs('8h')).toBe(8 * 3_600_000);
      expect(parseJwtExpiryToMs('45m')).toBe(45 * 60_000);
      expect(parseJwtExpiryToMs('30s')).toBe(30_000);
      expect(parseJwtExpiryToMs('7d')).toBe(7 * 86_400_000);
      expect(parseJwtExpiryToMs('1500')).toBe(1500); // bare digits = ms (jsonwebtoken semantics)
    });

    it('the default expiry (8h) is what the cookie maxAge mirrors', () => {
      const env = mkEnv();
      expect(sessionCookieOptions(env).maxAge).toBe(parseJwtExpiryToMs(env.JWT_EXPIRES_IN));
      expect(env.JWT_EXPIRES_IN).toBe('8h');
    });
  });

  describe('cookie options', () => {
    it('the session cookie is HttpOnly + SameSite=Strict', () => {
      const options = sessionCookieOptions(mkEnv());
      expect(options).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/' });
    });

    it('the CSRF cookie is deliberately readable (double submit) but never the session', () => {
      const csrf = csrfCookieOptions(mkEnv());
      const session = sessionCookieOptions(mkEnv());
      expect(csrf.httpOnly).toBe(false);
      expect(session.httpOnly).toBe(true);
      expect(csrf.maxAge).toBe(session.maxAge);
    });

    it('Secure defaults ON in production and OFF in development', () => {
      const prodEnv = {
        NODE_ENV: 'production',
        JWT_SECRET: 'prod-secret-0123456789abcdef0123456789abcdef',
        ADMIN_PASSWORD: 'Prod-Admin-2026!x',
        SEED_DEMO_DATA: 'false',
      };
      expect(isCookieSecure(mkEnv(prodEnv))).toBe(true);
      expect(isCookieSecure(mkEnv())).toBe(false);
      // explicit override beats the default (exotic TLS-terminating proxies)
      expect(isCookieSecure(mkEnv({ COOKIE_SECURE: 'true' }))).toBe(true);
      expect(isCookieSecure(mkEnv({ ...prodEnv, COOKIE_SECURE: 'false' }))).toBe(false);
    });

    it('clearCookie options match the set options (SameSite/Secure/path)', () => {
      const env = mkEnv();
      const session = sessionCookieOptions(env);
      const clear = clearCookieOptions(env);
      expect(clear).toEqual({ sameSite: session.sameSite, secure: session.secure, path: session.path });
    });
  });

  describe('readCookieHeader', () => {
    it('reads a value from a raw Cookie header without cookie-parser', () => {
      const header = `other=value; ${SESSION_COOKIE_NAME}=the-jwt; ${CSRF_COOKIE_NAME}=csrf-token`;
      expect(readCookieHeader(header, SESSION_COOKIE_NAME)).toBe('the-jwt');
      expect(readCookieHeader(header, CSRF_COOKIE_NAME)).toBe('csrf-token');
      expect(readCookieHeader(header, 'missing')).toBeUndefined();
      expect(readCookieHeader(undefined, SESSION_COOKIE_NAME)).toBeUndefined();
    });

    it('URL-decodes cookie values', () => {
      expect(readCookieHeader('abrit_session=abc.def%2Cghi', 'abrit_session')).toBe('abc.def,ghi');
    });
  });

  describe('env: JWT_EXPIRES_IN format is validated at boot', () => {
    it('accepts unit formats and refuses nonsense (cookie maxAge mirrors it)', () => {
      expect(() => mkEnv({ JWT_EXPIRES_IN: '7d' })).not.toThrow();
      expect(() => mkEnv({ JWT_EXPIRES_IN: 'two weeks' })).toThrow(/must look like/);
      expect(() => mkEnv({ JWT_EXPIRES_IN: '-5h' })).toThrow(/must look like/);
    });
  });

  it('setTestEnv keeps the shared base valid with the new schema', () => {
    setTestEnv();
    expect(() => parseEnv(process.env as Record<string, string | undefined>)).not.toThrow();
  });
});
