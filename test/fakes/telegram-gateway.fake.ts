import { TelegramApiError, TelegramGateway } from '../../src/modules/telegram/telegram-gateway.interface';
import { RawTelegramUpdate } from '../../src/modules/telegram/types';

/**
 * In-memory Telegram transport for tests: records every outbound send and can
 * simulate failures. No test ever talks to the real Telegram API.
 */
export class FakeTelegramGateway implements TelegramGateway {
  readonly active = true;
  public sent: { chat_id: string; text: string }[] = [];
  public failNext = false;
  /** Queue of errors to throw on the next sends (review round 5: 403 / timeout scenarios). */
  private errorQueue: TelegramApiError[] = [];
  private counter = 100_000;

  async sendMessage(params: { chat_id: string; text: string }): Promise<{ message_id: string }> {
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

  /** Queues a TelegramApiError for the NEXT send(s) — e.g. a 403 to simulate
   *  a user who blocked the bot while an old send was in flight. */
  failNextWith(error: TelegramApiError): void {
    this.errorQueue.push(error);
  }

  reset(): void {
    this.sent = [];
    this.failNext = false;
    this.errorQueue = [];
  }
}
