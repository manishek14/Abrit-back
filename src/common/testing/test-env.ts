/**
 * Minimal valid environment for unit tests. The sandbox may carry a foreign
 * DATABASE_URL (process env beats .env files by design), so tests pin their
 * own values before any getEnv() call happens.
 */
export function setTestEnv(overrides: Record<string, string> = {}): void {
  const base: Record<string, string> = {
    PORT: '3000',
    DATABASE_URL: 'postgres://abrit:abrit@127.0.0.1:5432/abrit_test',
    CORS_ORIGIN: 'http://localhost:5173',
    APP_TIMEZONE: 'Asia/Tehran',
    JWT_SECRET: 'unit-test-secret-value-0123456789',
    JWT_EXPIRES_IN: '8h',
    ADMIN_EMAIL: 'admin@abrit.local',
    ADMIN_PASSWORD: 'Admin1234!',
    MIGRATIONS_RUN: 'false',
    SEED_DEMO_DATA: 'false',
    TELEGRAM_MODE: 'polling',
    TELEGRAM_ALLOWED_UPDATES: 'message',
    OPENROUTER_DEFAULT_MODEL: 'openrouter/auto',
    OPENROUTER_TIMEOUT_MS: '25000',
    AI_CONTEXT_MAX_MESSAGES: '20',
    AI_MAX_CONCURRENCY: '3',
    AI_MAX_OUTPUT_TOKENS: '500',
    AI_CONTEXT_MAX_CHARS: '21000',
  };
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    process.env[k] = v;
  }
}
