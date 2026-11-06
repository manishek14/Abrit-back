import { Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import { Env } from '../../config/env';
import { RawTelegramUpdate } from './types';
import { TelegramApiError, TelegramGateway } from './telegram-gateway.interface';

/**
 * Real Telegram transport built on Telegraf. Created ONLY when TELEGRAM_BOT_TOKEN
 * is configured; while the token is empty this class is never instantiated.
 * Launch happens in onApplicationBootstrap so the ingest handler is registered
 * before the first update arrives.
 *
 * Request timeout (review round 5 fix #2): every sendMessage is bounded by
 * TELEGRAM_SEND_TIMEOUT_MS — by default 30 s, strictly BELOW the delivery
 * lease (60 s). A hung request now fails fast as a TRANSIENT error (retried
 * with backoff) instead of outliving its lease, which previously let the
 * sweeper re-claim the message and double-send it while worker 1 was still
 * in flight.
 */
export class TelegrafGateway implements TelegramGateway, OnApplicationBootstrap, OnModuleDestroy {
  readonly active = true;
  private readonly logger = new Logger('TelegramTransport');
  private readonly bot: Telegraf;
  private readonly allowedUpdates: string[];
  private updateHandler?: (update: RawTelegramUpdate) => Promise<void>;

  constructor(private readonly env: Env) {
    this.bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
    this.allowedUpdates = env.TELEGRAM_ALLOWED_UPDATES.split(',').map((s) => s.trim()).filter(Boolean);

    this.bot.on('message', (ctx) => {
      const update = ctx.update as unknown as RawTelegramUpdate;
      if (this.updateHandler) {
        void this.updateHandler(update).catch((e) =>
          this.logger.error(`update handler failed: ${(e as Error).message}`),
        );
      }
    });
  }

  setUpdateHandler(handler: (update: RawTelegramUpdate) => Promise<void>): void {
    this.updateHandler = handler;
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      if (this.env.TELEGRAM_MODE === 'webhook') {
        await this.bot.telegram.setWebhook(this.env.TELEGRAM_WEBHOOK_URL, {
          secret_token: this.env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: this.allowedUpdates as never,
        });
        this.logger.log(`Webhook registered: ${this.env.TELEGRAM_WEBHOOK_URL}`);
      } else {
        // polling mode: clear any leftover webhook, then start long polling
        await this.bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => undefined);
        await this.bot.launch({ allowedUpdates: this.allowedUpdates as never });
        this.logger.log('Polling started (allowed_updates: ' + this.allowedUpdates.join(',') + ')');
      }
    } catch (e) {
      // The API keeps serving (health, panel, tests); outbound messages fail and retry.
      this.logger.error(`Telegram transport failed to start: ${(e as Error).message}`);
    }
  }

  onModuleDestroy(): void {
    try {
      this.bot.stop('shutdown');
    } catch {
      /* not started — nothing to stop */
    }
  }

  async sendMessage(params: { chat_id: string; text: string }): Promise<{ message_id: string }> {
    try {
      const res = (await this.withSendTimeout(
        this.bot.telegram.sendMessage(params.chat_id, params.text),
      )) as { message_id: number };
      return { message_id: String(res.message_id) };
    } catch (e) {
      // the timeout rejection is already a typed TelegramApiError — pass it
      // through untouched so it stays TRANSIENT (retried with backoff)
      if (e instanceof TelegramApiError) throw e;
      throw this.mapError(e);
    }
  }

  /** Races the request against the configured timeout; the timeout loses to a
   *  real response and wins with a TRANSIENT TelegramApiError otherwise. The
   *  abandoned underlying request gets a no-op catch so it can never surface
   *  an unhandled rejection if it fails later (it may even still succeed on
   *  Telegram's side — that residual at-least-once window is documented in
   *  OutboxDispatcherService and cannot be closed from the client). */
  private withSendTimeout<T>(request: Promise<T>): Promise<T> {
    const timeoutMs = this.env.TELEGRAM_SEND_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new TelegramApiError(
              `telegram request timed out after ${timeoutMs}ms`,
              null,
              false,
            ),
          ),
        timeoutMs,
      );
      timer.unref?.(); // never keep the process alive for a pending timeout
    });
    request.catch(() => undefined);
    return Promise.race([request, timeout]) as Promise<T>;
  }

  private mapError(e: unknown): TelegramApiError {
    const res = (
      e as {
        response?: { error_code?: number; description?: string; parameters?: { retry_after?: number } };
      }
    )?.response;
    const code = res?.error_code ?? null;
    const description = res?.description ?? (e as Error)?.message ?? 'telegram request failed';

    if (code === 403) return new TelegramApiError(description, 403, true);
    if (code === 400 && PERMANENT_400_PATTERNS.some((p) => p.test(description))) {
      // TRANSIENT/PERMANENT SPLIT (review round 5 fix #1): these 400s will
      // NEVER succeed on retry — do not burn the 5-attempt budget on them.
      return new TelegramApiError(description, 400, true);
    }
    if (code === 429) {
      return new TelegramApiError(description, 429, false, res?.parameters?.retry_after);
    }
    return new TelegramApiError(description, code, false);
  }
}

/** 400-family descriptions that can never succeed on retry (content/chat
 *  problems, not availability problems). Anything NOT matched here stays
 *  retryable — an unknown 400 may still be a transient Telegram hiccup. */
const PERMANENT_400_PATTERNS = [
  /chat not found/i,
  /message text is empty/i,
  /message is too long/i,
  /message thread not found/i,
];
