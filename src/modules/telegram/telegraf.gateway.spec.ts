import { Telegraf } from 'telegraf';
import { TelegrafGateway } from './telegraf.gateway';
import { TelegramApiError } from './telegram-gateway.interface';
import { DELIVERY_LEASE_MS } from '../messages/messages.service';
import { parseEnv, type Env } from '../../config/env';

/**
 * Review round 5 fix #2 — the Telegram request timeout:
 * a send must fail fast (TRANSIENT, retried with backoff) well before its
 * delivery lease expires; previously a hung request outlived the 60 s lease,
 * the sweeper re-claimed the message and a second worker double-sent it.
 */
describe('TelegrafGateway (send timeout & error classification)', () => {
  const mkEnv = (over: Record<string, string> = {}) =>
    parseEnv({
      DATABASE_URL: 'postgres://abrit@127.0.0.1:5432/abrit',
      JWT_SECRET: 'unit-test-secret-value-0123456789',
      TELEGRAM_BOT_TOKEN: '123:abc',
      ...over,
    } as Record<string, string>);

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
