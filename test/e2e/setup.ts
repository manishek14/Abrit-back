/**
 * Runs BEFORE any e2e module is loaded: pins the whole environment to the TEST
 * database (db-test service on :5433 via docker compose, or the default below).
 * Override with E2E_DATABASE_URL when needed.
 */
const e2eEnv: Record<string, string> = {
  DATABASE_URL: process.env.E2E_DATABASE_URL || 'postgres://abrit:abrit@127.0.0.1:5432/abrit_test',
  MIGRATIONS_RUN: 'true',
  SEED_DEMO_DATA: 'false',
  PORT: '3999',
  CORS_ORIGIN: 'http://localhost:5173',
  APP_TIMEZONE: 'Asia/Tehran',
  JWT_SECRET: 'e2e-test-secret-value-0123456789',
  JWT_EXPIRES_IN: '1h',
  ADMIN_EMAIL: 'admin@abrit.local',
  ADMIN_PASSWORD: 'Admin1234!',
  TELEGRAM_MODE: 'polling',
  TELEGRAM_BOT_TOKEN: '', // disabled — the fake gateway drives delivery
  TELEGRAM_WEBHOOK_SECRET: 'e2e-webhook-secret',
  TELEGRAM_ALLOWED_UPDATES: 'message',
  OPENROUTER_API_KEY: '', // disabled — replies use the honest fallback
  OPENROUTER_DEFAULT_MODEL: 'openrouter/auto',
  OPENROUTER_TIMEOUT_MS: '25000',
  AI_CONTEXT_MAX_MESSAGES: '20',
  AI_MAX_CONCURRENCY: '3',
  AI_MAX_OUTPUT_TOKENS: '500',
  AI_CONTEXT_MAX_CHARS: '21000',
};

Object.assign(process.env, e2eEnv);
