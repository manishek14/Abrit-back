import { z } from 'zod';

/**
 * Central environment schema. The app fails fast with a readable message instead
 * of booting with a broken config. Secrets are never hardcoded: Telegram and
 * OpenRouter credentials are intentionally optional and default to EMPTY — while
 * empty, those integrations stay disabled (per the project owner's instruction)
 * and the rest of the system works normally.
 *
 * Review fix (settings & security):
 *  - known/example JWT secrets are REJECTED (even in development),
 *  - production additionally demands a 32+ char secret, an explicitly set
 *    admin password (defaults are refused), and SEED_DEMO_DATA=false,
 *  - demo seeding stays a development convenience only.
 */
const boolString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

/** Placeholder/known-weak values that must never boot, in ANY environment. */
const FORBIDDEN_JWT_SECRETS = new Set([
  'change-me-to-a-long-random-string-32-chars',
  'replace-with-a-random-secret-at-least-32-chars',
  'change-me',
  'changeme',
  'secret',
  'secrets',
  'jwt-secret',
  'jwt_secret',
  'super-secret',
  'dev-secret',
  'your-secret',
  'your-secret-here',
  'test-secret',
  'shhh',
  'shhhhh',
  '12345678901234567890',
  'abcdefghijklmnop',
]);

/** Default/well-known admin passwords refused in production. */
const FORBIDDEN_ADMIN_PASSWORDS = new Set([
  'Admin1234!',
  'admin',
  'admin123',
  'admin1234',
  'password',
  'password123',
  '12345678',
  '123456789',
  'qwerty123',
]);

/** Blank after trimming — length rules must never pass a whitespace-padded
 *  value (review fix: "32 spaces" must not clear a 32-char check). */
function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/** Obviously-low-entropy bodies (review fix): a single repeated character, or
 *  a short block (≤ 8 chars) repeated to pad the length. Real random secrets
 *  never have this shape. */
function isRepetitivePattern(value: string): boolean {
  const trimmed = value.trim();
  return /^(.)\1+$/.test(trimmed) || /^(.{1,8})\1+$/.test(trimmed);
}

/** Independent admin-password strength check (review fix): ≥ 12 trimmed
 *  characters, not a known default, not a repetitive pattern, and at least
 *  3 of the 4 character classes (lowercase / UPPERCASE / digits / symbols —
 *  whitespace never counts as a class). */
function isStrongAdminPassword(password: string): boolean {
  if (FORBIDDEN_ADMIN_PASSWORDS.has(password)) return false;
  if (isRepetitivePattern(password)) return false;
  if (password.length < 12) return false;
  const classes =
    (/[a-z]/.test(password) ? 1 : 0) +
    (/[A-Z]/.test(password) ? 1 : 0) +
    (/\d/.test(password) ? 1 : 0) +
    (/[^\sa-zA-Z0-9]/.test(password) ? 1 : 0);
  return classes >= 3;
}

export const RawEnvSchema = z
  .object({
    // --- runtime environment (drives the production rules below) ---
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // --- server ---
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    APP_TIMEZONE: z.string().default('Asia/Tehran'),

    // --- database ---
    DATABASE_URL: z
      .string()
      .min(1, 'required, e.g. postgres://abrit:abrit@127.0.0.1:5432/abrit')
      .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must start with postgres:// — this project uses PostgreSQL'),
    MIGRATIONS_RUN: boolString.default('true'),
    // development convenience only — see the production rule in superRefine
    SEED_DEMO_DATA: boolString.optional(),
    // review fix (retention): raw Telegram payloads are purged after N days
    // (conversation messages are kept); 0 disables the purge.
    BOT_UPDATES_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(30),

    // --- auth / first admin ---
    JWT_SECRET: z
      .string()
      .min(1, 'required and must be a real secret (no default on purpose) — length is validated after trimming'),
    JWT_EXPIRES_IN: z.string().default('8h'),
    ADMIN_EMAIL: z.string().email().default('admin@abrit.local'),
    ADMIN_PASSWORD: z.string()
      .min(8, 'at least 8 characters')
      .optional()
      .or(z.literal('').transform(() => undefined)),

    // --- telegram (EMPTY = disabled) ---
    TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
    TELEGRAM_BOT_TOKEN: z.string().default(''),
    TELEGRAM_WEBHOOK_URL: z.string().default(''),
    TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
    TELEGRAM_ALLOWED_UPDATES: z.string().default('message'),
    // Review round 5 fix #2: outbound Telegram requests fail fast as TRANSIENT
    // when hung. MUST stay below the 60 s delivery lease (DELIVERY_LEASE_MS) —
    // a request that could outlive its lease is exactly the double-send window
    // the fencing fix closes. Enforced by a unit test + gateway behavior; the
    // 120 s max here keeps absurd values out.
    TELEGRAM_SEND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),

    // --- AI / OpenRouter (EMPTY = disabled, fixed fallback reply) ---
    OPENROUTER_API_KEY: z.string().default(''),
    OPENROUTER_DEFAULT_MODEL: z.string().default('openrouter/auto'),
    OPENROUTER_TIMEOUT_MS: z.coerce.number().int().min(1000).default(25000),
    AI_CONTEXT_MAX_MESSAGES: z.coerce.number().int().min(2).max(200).default(20),
    AI_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(50).max(4000).default(500),
    AI_CONTEXT_MAX_CHARS: z.coerce.number().int().min(2000).max(200_000).default(21_000),
  })
  .superRefine((cfg, ctx) => {
    const isProduction = cfg.NODE_ENV === 'production';

    // --- JWT secret: length is enforced on the TRIMMED value, blank and
    // obviously-weak bodies are rejected EVERYWHERE (review fix: raw-length
    // checks let "32 spaces" or "a" × 32 pass) ---
    if (isBlank(cfg.JWT_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'must not be blank/whitespace — generate a real secret, e.g. `openssl rand -hex 32`',
      });
    } else {
      // (underscores and hyphens are treated alike so both placeholder styles die)
      const normalizedSecret = cfg.JWT_SECRET.trim().toLowerCase().replace(/_/g, '-');
      const trimmedSecret = cfg.JWT_SECRET.trim();
      if (FORBIDDEN_JWT_SECRETS.has(normalizedSecret)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SECRET'],
          message: 'this is a known/example value — generate a real secret, e.g. `openssl rand -hex 32`',
        });
      } else if (isRepetitivePattern(cfg.JWT_SECRET)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SECRET'],
          message: 'this is a repeated pattern — far too predictable. Use a real random secret, e.g. `openssl rand -hex 32`',
        });
      } else if (isProduction && trimmedSecret.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SECRET'],
          message: 'must be at least 32 characters in production (e.g. `openssl rand -hex 32`)',
        });
      } else if (!isProduction && trimmedSecret.length < 16) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SECRET'],
          message: 'must be at least 16 characters (whitespace does not count)',
        });
      }
    }

    // --- first admin: production requires an explicit, strong password ---
    if (isProduction) {
      const password = cfg.ADMIN_PASSWORD;
      if (!password || isBlank(password)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_PASSWORD'],
          message: 'must be set explicitly in production (blank/whitespace is not a password)',
        });
      } else if (!isStrongAdminPassword(password.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_PASSWORD'],
          message:
            'must be a strong unique value in production — 12+ trimmed characters with at least 3 of lowercase/UPPERCASE/digits/symbols',
        });
      }

      if (cfg.SEED_DEMO_DATA === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SEED_DEMO_DATA'],
          message: 'must NOT be enabled in production — set it to false (demo users/tickets must never enter a real database)',
        });
      }
    }

    // --- webhook mode needs its full credential set ---
    if (cfg.TELEGRAM_MODE === 'webhook') {
      if (!cfg.TELEGRAM_BOT_TOKEN) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['TELEGRAM_BOT_TOKEN'], message: 'required when TELEGRAM_MODE=webhook' });
      }
      if (!cfg.TELEGRAM_WEBHOOK_URL) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['TELEGRAM_WEBHOOK_URL'], message: 'required when TELEGRAM_MODE=webhook' });
      }
      if (!cfg.TELEGRAM_WEBHOOK_SECRET) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['TELEGRAM_WEBHOOK_SECRET'], message: 'required when TELEGRAM_MODE=webhook' });
      }
    }
  });

/** The final, fully-defaulted environment type consumers see. */
export type Env = z.infer<typeof RawEnvSchema> & {
  NODE_ENV: 'development' | 'test' | 'production';
  SEED_DEMO_DATA: boolean;
  ADMIN_PASSWORD: string;
};

/** Validates a raw env record and throws a readable error on failure. */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const parsed = RawEnvSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${lines}\nHint: copy .env.example to .env and adjust the values.`,
    );
  }

  const env = parsed.data as Env;
  // Derived defaults (review fix): demo seeding and the bootstrap admin
  // password are development conveniences — production must opt in explicitly.
  if (env.SEED_DEMO_DATA === undefined) {
    env.SEED_DEMO_DATA = env.NODE_ENV !== 'production';
  }
  if (!env.ADMIN_PASSWORD) {
    env.ADMIN_PASSWORD = 'Admin1234!'; // development/test only — production rejects it above
  }
  return env;
}

/** Parse the merged process.env (ConfigModule injects .env file values before first use). */
export function getEnv(): Env {
  return parseEnv(process.env as unknown as Record<string, string | undefined>);
}
