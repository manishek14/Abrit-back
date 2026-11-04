import { z } from 'zod';

/**
 * Central environment schema. The app fails fast with a readable message instead
 * of booting with a broken config. Secrets are never hardcoded: Telegram and
 * OpenRouter credentials are intentionally optional and default to EMPTY — while
 * empty, those integrations stay disabled (per the project owner's instruction)
 * and the rest of the system works normally.
 */
const boolString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

export const EnvSchema = z
  .object({
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
    SEED_DEMO_DATA: boolString.default('true'),

    // --- auth / first admin ---
    JWT_SECRET: z
      .string()
      .min(16, 'required and must be at least 16 characters (no default on purpose)'),
    JWT_EXPIRES_IN: z.string().default('8h'),
    ADMIN_EMAIL: z.string().email().default('admin@abrit.local'),
    ADMIN_PASSWORD: z.string().min(8, 'at least 8 characters').default('Admin1234!'),

    // --- telegram (EMPTY = disabled) ---
    TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
    TELEGRAM_BOT_TOKEN: z.string().default(''),
    TELEGRAM_WEBHOOK_URL: z.string().default(''),
    TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
    TELEGRAM_ALLOWED_UPDATES: z.string().default('message'),

    // --- AI / OpenRouter (EMPTY = disabled, fixed fallback reply) ---
    OPENROUTER_API_KEY: z.string().default(''),
    OPENROUTER_DEFAULT_MODEL: z.string().default('openrouter/auto'),
    OPENROUTER_TIMEOUT_MS: z.coerce.number().int().min(1000).default(25000),
    AI_CONTEXT_MAX_MESSAGES: z.coerce.number().int().min(2).max(200).default(20),
    AI_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
  })
  .superRefine((cfg, ctx) => {
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

export type Env = z.infer<typeof EnvSchema>;

/** Validates a raw env record and throws a readable error on failure. */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${lines}\nHint: copy .env.example to .env and adjust the values.`,
    );
  }
  return parsed.data;
}

/** Parse the merged process.env (ConfigModule injects .env file values before first use). */
export function getEnv(): Env {
  return parseEnv(process.env as unknown as Record<string, string | undefined>);
}
