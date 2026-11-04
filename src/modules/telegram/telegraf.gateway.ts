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
      const res = (await this.bot.telegram.sendMessage(params.chat_id, params.text)) as {
        message_id: number;
      };
      return { message_id: String(res.message_id) };
    } catch (e) {
      throw this.mapError(e);
    }
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
    if (code === 400 && /chat not found/i.test(description)) {
      return new TelegramApiError(description, 400, true);
    }
    if (code === 429) {
      return new TelegramApiError(description, 429, false, res?.parameters?.retry_after);
    }
    return new TelegramApiError(description, code, false);
  }
}
