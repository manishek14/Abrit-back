import { Telegraf } from 'telegraf';
import { TelegrafGateway } from './telegraf.gateway';
import { TelegramApiError } from './telegram-gateway.interface';
import { DELIVERY_LEASE_MS } from '../messages/messages.service';
import { parseEnv, type Env } from '../../config/env';
import { IntegrationStateService } from '../../common/integration-state/integration-state.service';

/**
 * Review round 5 fix #2 — the Telegram request timeout:
 * a send must fail fast (TRANSIENT, retried with backoff) well before its
 * delivery lease expires; previously a hung request outlived the 60 s lease,
 * the sweeper re-claimed the message and a second worker double-sent it.
 *
 * Review round 6 fix #1 — bootstrap degradation:
 * a failed Telegram bootstrap (bad token, unreachable API, failed webhook
 * registration) must never leave the app looking healthy while the bot is
 * dead. The gateway now reports the lifecycle into IntegrationStateService
 * and PRODUCTION refuses to serve at all (the error is rethrown).
 */
const mkEnv = (over: Record<string, string> = {}) =>
  parseEnv({
    DATABASE_URL: 'postgres://abrit@127.0.0.1:5432/abrit',
    JWT_SECRET: 'unit-test-secret-value-0123456789',
    TELEGRAM_BOT_TOKEN: '123:abc',
    ...over,
  } as Record<string, string>);

describe('TelegrafGateway (send timeout & error classification)', () => {
  const mkGateway = (env: Env = mkEnv()): TelegrafGateway => {
    const gateway = new TelegrafGateway(env);
    return gateway;
  };

  /** The gateway reads a few env fields in its constructor — short timeouts
   *  below the schema's 1 s floor are fine for fast unit tests. */
  const rawEnvWithTimeout = (timeoutMs: number): Env =>
    ({
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_ALLOWED_UPDATES: 'message',
      TELEGRAM_SEND_TIMEOUT_MS: timeoutMs,
    }) as unknown as Env;

  const stubBot = (gateway: TelegrafGateway, impl: () => Promise<unknown>): void => {
    // replace the Telegraf API seam — no network, the promise shape is what matters
    (gateway as unknown as { bot: Telegraf }).bot.telegram = {
      sendMessage: jest.fn(impl),
    } as unknown as Telegraf['telegram'];
  };

  it('the default TELEGRAM_SEND_TIMEOUT_MS is strictly below the delivery lease', () => {
    const env = mkEnv();
    expect(env.TELEGRAM_SEND_TIMEOUT_MS).toBe(30_000);
    expect(env.TELEGRAM_SEND_TIMEOUT_MS).toBeLessThan(DELIVERY_LEASE_MS);
  });

  it('a hung request rejects with a TRANSIENT TelegramApiError after the timeout', async () => {
    const gateway = mkGateway(rawEnvWithTimeout(50));
    stubBot(gateway, () => new Promise(() => undefined)); // never resolves

    await expect(gateway.sendMessage({ chat_id: '1', text: 'سلام' })).rejects.toMatchObject({
      name: 'TelegramApiError',
      code: null,
      permanent: false, // transient → retried with backoff
      message: expect.stringContaining('timed out'),
    });
  });

  it('a fast response still wins over the timeout', async () => {
    const gateway = mkGateway(rawEnvWithTimeout(5000));
    stubBot(gateway, async () => ({ message_id: 42 }));

    await expect(gateway.sendMessage({ chat_id: '1', text: 'سلام' })).resolves.toEqual({
      message_id: '42',
    });
  });

  it('the underlying request failing AFTER the timeout never becomes an unhandled rejection', async () => {
    const gateway = mkGateway(rawEnvWithTimeout(30));
    stubBot(
      gateway,
      () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('late network failure')), 120),
        ),
    );

    await expect(gateway.sendMessage({ chat_id: '1', text: 'سلام' })).rejects.toBeInstanceOf(
      TelegramApiError,
    );
    // give the late rejection its moment — an unhandled rejection would fail
    // the test process; the gateway's no-op catch must absorb it
    await new Promise((r) => setTimeout(r, 200));
  });

  it('known-permanent 400 descriptions are classified PERMANENT (no wasted retries)', async () => {
    const gateway = mkGateway();
    stubBot(gateway, () => {
      throw Object.assign(new Error('Bad Request: chat not found'), {
        response: { error_code: 400, description: 'Bad Request: chat not found' },
      });
    });

    await expect(gateway.sendMessage({ chat_id: '1', text: 'سلام' })).rejects.toMatchObject({
      permanent: true,
      code: 400,
    });
  });

  it('an UNKNOWN 400 stays retryable (could be a transient Telegram hiccup)', async () => {
    const gateway = mkGateway();
    stubBot(gateway, () => {
      throw Object.assign(new Error('Bad Request: something odd'), {
        response: { error_code: 400, description: 'Bad Request: something odd' },
      });
    });

    await expect(gateway.sendMessage({ chat_id: '1', text: 'سلام' })).rejects.toMatchObject({
      permanent: false,
      code: 400,
    });
  });
});

/**
 * Review round 6 fix #1 — a failed Telegram bootstrap must be VISIBLE.
 * The old behavior logged the error and kept serving: health stayed green
 * while the bot was dead. Now the lifecycle lands in IntegrationStateService
 * (readiness probe + panel) and production aborts the boot entirely.
 */
describe('TelegrafGateway (bootstrap degradation)', () => {
  /** Env for production-mode tests — the production rules demand a 32+ char
   *  secret, an explicit strong admin password and no demo seeding. */
  const mkProdEnv = (): Env =>
    parseEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://abrit@127.0.0.1:5432/abrit',
      JWT_SECRET: 'prod-secret-0123456789abcdef0123456789abcdef',
      ADMIN_PASSWORD: 'Prod-Admin-2026!x',
      SEED_DEMO_DATA: 'false',
      TELEGRAM_BOT_TOKEN: '123:abc',
    } as Record<string, string>);

  /** Replaces the whole Telegraf API seam: no network anywhere. */
  const stubApi = (gateway: TelegrafGateway, impl: Partial<Record<string, jest.Mock>>): void => {
    (gateway as unknown as { bot: Telegraf }).bot.telegram = {
      getMe: jest.fn().mockResolvedValue({ id: 1, username: 'abrit_bot' }),
      setWebhook: jest.fn().mockResolvedValue(undefined),
      deleteWebhook: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn(),
      ...impl,
    } as unknown as Telegraf['telegram'];
  };

  it('a successful bootstrap (getMe + launch) reports the integration as ok', async () => {
    const state = new IntegrationStateService();
    const gateway = new TelegrafGateway(mkEnv(), state);
    stubApi(gateway, { getMe: jest.fn().mockResolvedValue({ id: 1, username: 'abrit_bot' }) });
    (gateway as unknown as { bot: Telegraf }).bot.launch = jest.fn().mockResolvedValue(undefined);

    await gateway.onApplicationBootstrap();

    expect(state.snapshot().telegram).toMatchObject({ status: 'ok' });
  });

  it('a failed bootstrap in development marks the integration degraded and keeps serving', async () => {
    const state = new IntegrationStateService();
    const gateway = new TelegrafGateway(mkEnv(), state);
    stubApi(gateway, {
      getMe: jest.fn().mockRejectedValue(new Error('401: Unauthorized')),
    });

    // must NOT throw — the API/panel stay up in development, visibly degraded
    await expect(gateway.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(state.snapshot().telegram).toMatchObject({
      status: 'degraded',
      detail: expect.stringContaining('401'),
    });
  });

  it('a failed bootstrap in PRODUCTION rethrows so the process refuses to serve', async () => {
    const state = new IntegrationStateService();
    const gateway = new TelegrafGateway(mkProdEnv(), state);
    stubApi(gateway, {
      getMe: jest.fn().mockRejectedValue(new Error('401: Unauthorized')),
    });

    await expect(gateway.onApplicationBootstrap()).rejects.toThrow('401: Unauthorized');
    expect(state.snapshot().telegram).toMatchObject({ status: 'degraded' });
  });

  it('reports "starting" while the bootstrap is still in flight', async () => {
    const state = new IntegrationStateService();
    const gateway = new TelegrafGateway(mkEnv(), state);
    let resolveGetMe: (v: unknown) => void = () => undefined;
    stubApi(gateway, {
      getMe: jest.fn().mockReturnValue(new Promise((r) => (resolveGetMe = r))),
    });
    (gateway as unknown as { bot: Telegraf }).bot.launch = jest.fn().mockResolvedValue(undefined);

    const bootstrap = gateway.onApplicationBootstrap();
    expect(state.snapshot().telegram.status).toBe('starting');

    resolveGetMe({ id: 1 });
    await bootstrap;
    expect(state.snapshot().telegram.status).toBe('ok');
  });

  it('a webhook-mode bootstrap failure also degrades (setWebhook rejects)', async () => {
    const state = new IntegrationStateService();
    const gateway = new TelegrafGateway(mkEnv({ TELEGRAM_MODE: 'webhook', TELEGRAM_WEBHOOK_URL: 'https://x.example/api/telegram/webhook', TELEGRAM_WEBHOOK_SECRET: 's3cret-value-01' }), state);
    stubApi(gateway, {
      getMe: jest.fn().mockResolvedValue({ id: 1 }),
      setWebhook: jest.fn().mockRejectedValue(new Error('400: Bad Request')),
    });

    await expect(gateway.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(state.snapshot().telegram).toMatchObject({
      status: 'degraded',
      detail: expect.stringContaining('400'),
    });
  });

  it('a hung getMe cannot stall the boot forever (bounded probe)', async () => {
    const state = new IntegrationStateService();
    const gateway = new TelegrafGateway(mkEnv(), state);
    stubApi(gateway, { getMe: jest.fn().mockReturnValue(new Promise(() => undefined)) });

    // the probe timeout is injected for tests (default 15 s) — 60 ms here
    await expect(gateway.onApplicationBootstrap(60)).resolves.toBeUndefined();
    expect(state.snapshot().telegram).toMatchObject({
      status: 'degraded',
      detail: expect.stringContaining('timed out'),
    });
  });
});

