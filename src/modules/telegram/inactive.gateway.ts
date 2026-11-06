import { RawTelegramUpdate } from './types';
import { TelegramApiError, TelegramGateway } from './telegram-gateway.interface';

/**
 * Bound while TELEGRAM_BOT_TOKEN is empty (current state, per the project
 * owner's instruction): every real send fails permanently with a clear reason,
 * which is visible on the ticket messages in the panel. The processing pipeline
 * (ingest → ticket → AI → outbox) keeps working end-to-end with fakes in tests.
 */
export class InactiveGateway implements TelegramGateway {
  readonly active = false;

  sendMessage(): Promise<{ message_id: string }> {
    throw new TelegramApiError(
      'Telegram bot token is not configured — outbound delivery disabled',
      null,
      true,
    );
  }

  setUpdateHandler(_handler: (update: RawTelegramUpdate) => Promise<void>): void {
    /* no transport — updates only arrive via the webhook controller in tests */
  }

  answerCallbackQuery(_callbackQueryId: string, _text?: string): Promise<void> {
    /* no transport — nothing to answer */
    return Promise.resolve();
  }
}
