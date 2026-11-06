import { TelegramApiError, TelegramGateway, SendMessageParams } from '../../src/modules/telegram/telegram-gateway.interface';
import { RawTelegramUpdate } from '../../src/modules/telegram/types';

/**
 * In-memory Telegram transport for tests: records every outbound send (with
 * keyboards/parse-mode) and can simulate failures. No test ever talks to the
 * real Telegram API.
 */
export class FakeTelegramGateway implements TelegramGateway {
  readonly active = true;
  public sent: SendMessageParams[] = [];
  public failNext = false;
  /** Queue of errors to throw on the next sends (review round 5: 403 / timeout scenarios). */
  private errorQueue: TelegramApiError[] = [];
  private counter = 100_000;
  /** Recorded answerCallbackQuery calls (my-tickets inline keyboards). */
  public answeredCallbacks: { id: string; text?: string }[] = [];

  async sendMessage(params: SendMessageParams): Promise<{ message_id: string }> {
    if (this.errorQueue.length > 0) {
      throw this.errorQueue.shift();
    }
    if (this.failNext) {
      this.failNext = false;
      throw new TelegramApiError('simulated telegram failure', 500, false);
    }
    this.sent.push(params);
    return { message_id: String(this.counter++) };
  }

  setUpdateHandler(_handler: (update: RawTelegramUpdate) => Promise<void>): void {
    /* tests drive the pipeline through the webhook endpoint */
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    this.answeredCallbacks.push({ id: callbackQueryId, text });
  }

  /** Queues a TelegramApiError for the NEXT send(s) — e.g. a 403 to simulate
   *  a user who blocked the bot while an old send was in flight. */
  failNextWith(error: TelegramApiError): void {
    this.errorQueue.push(error);
  }

  reset(): void {
    this.sent = [];
    this.failNext = false;
    this.errorQueue = [];
    this.answeredCallbacks = [];
  }
}
