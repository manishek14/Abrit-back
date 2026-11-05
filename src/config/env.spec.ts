import { parseEnv } from './env';

/**
 * Review fix (settings & security): known/example secrets are refused, and the
 * development conveniences (demo seed, default admin password) must never leak
 * into a production boot.
 */

const baseEnv = (overrides: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: 'postgres://abrit:abrit@127.0.0.1:5432/abrit',
  JWT_SECRET: 'a-real-random-secret-0123456789abcdef',
  ...overrides,
});

describe('parseEnv (security rules)', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  });

  describe('JWT_SECRET blacklist (applies EVERYWHERE, including development)', () => {
    it.each([
      'change-me-to-a-long-random-string-32-chars',
      'REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_32_CHARS', // the .env.example placeholder
      'change-me',
      'jwt-secret',
      'secret',
      'super-secret',
      'dev-secret',
      '12345678901234567890',
    ])('rejects the known/example value %j', (secret) => {
      expect(() => parseEnv(baseEnv({ JWT_SECRET: secret }))).toThrow(/JWT_SECRET/);
    });

    it('accepts a real generated secret in development', () => {
      const env = parseEnv(baseEnv({ NODE_ENV: 'development' }));
      expect(env.JWT_SECRET).toBe('a-real-random-secret-0123456789abcdef');
    });

    it('production requires at least 32 characters', () => {
      expect(() =>
        parseEnv(baseEnv({ NODE_ENV: 'production', JWT_SECRET: 'short-but-real-0123456789' })),
      ).toThrow(/at least 32 characters in production/);

      const env = parseEnv(
        baseEnv({
          NODE_ENV: 'production',
          JWT_SECRET: 'openssl-rand-hex-32-abcdefghijklmnopqrstuvwxyz',
          ADMIN_PASSWORD: 'a-strong-unique-production-password',
          SEED_DEMO_DATA: 'false',
        }),
      );
      expect(env.NODE_ENV).toBe('production');
    });
  });

  describe('first admin password', () => {
    it('development: falls back to the documented default when unset', () => {
      const env = parseEnv(baseEnv({ NODE_ENV: 'development', ADMIN_PASSWORD: undefined }));
      expect(env.ADMIN_PASSWORD).toBe('Admin1234!');
    });

    it('production: unset password is refused', () => {
      expect(() =>
        parseEnv(
          baseEnv({
            NODE_ENV: 'production',
            ADMIN_PASSWORD: undefined,
            SEED_DEMO_DATA: 'false',
          }),
        ),
      ).toThrow(/ADMIN_PASSWORD/);
    });

    it('production: the development default is refused', () => {
      expect(() =>
        parseEnv(
          baseEnv({
            NODE_ENV: 'production',
            ADMIN_PASSWORD: 'Admin1234!',
            SEED_DEMO_DATA: 'false',
          }),
        ),
      ).toThrow(/ADMIN_PASSWORD/);
    });

    it('production: a strong explicit password is accepted', () => {
      const env = parseEnv(
        baseEnv({
          NODE_ENV: 'production',
          ADMIN_PASSWORD: 'correct-horse-battery-staple-42',
          SEED_DEMO_DATA: 'false',
        }),
      );
      expect(env.ADMIN_PASSWORD).toBe('correct-horse-battery-staple-42');
    });
  });

  describe('SEED_DEMO_DATA', () => {
    it('development: defaults to true (demo convenience)', () => {
      const env = parseEnv(baseEnv({ NODE_ENV: 'development', SEED_DEMO_DATA: undefined }));
      expect(env.SEED_DEMO_DATA).toBe(true);
    });

    it('production: defaults to false', () => {
      const env = parseEnv(
        baseEnv({
          NODE_ENV: 'production',
          SEED_DEMO_DATA: undefined,
          ADMIN_PASSWORD: 'correct-horse-battery-staple-42',
        }),
      );
      expect(env.SEED_DEMO_DATA).toBe(false);
    });

    it('production: explicitly true is refused', () => {
      expect(() =>
        parseEnv(
          baseEnv({
            NODE_ENV: 'production',
            SEED_DEMO_DATA: 'true',
            ADMIN_PASSWORD: 'correct-horse-battery-staple-42',
          }),
        ),
      ).toThrow(/SEED_DEMO_DATA/);
    });
  });

  it('keeps the retention default at 30 days and accepts overrides', () => {
    expect(parseEnv(baseEnv()).BOT_UPDATES_RETENTION_DAYS).toBe(30);
    expect(parseEnv(baseEnv({ BOT_UPDATES_RETENTION_DAYS: '0' })).BOT_UPDATES_RETENTION_DAYS).toBe(0);
  });
});
