import { Logger } from '@nestjs/common';
import { RawTelegramUpdate } from './types';
import { BotReplyMarkup } from './keyboards';

/** Send options — keyboards/parse-mode are optional; plain text stays the default. */
export interface SendMessageParams {
  chat_id: string;
  text: string;
  /** Reply/inline keyboard — only flow UI carries one; outbox sends stay plain. */
  reply_markup?: BotReplyMarkup;
  /** 'HTML' for template messages with <b> (user content is escaped upstream). */
  parse_mode?: 'HTML';
}

/**
 * Transport seam for Telegram — the whole system talks to THIS interface only,
 * so tests inject fakes and no network is ever touched while credentials are empty.
 */
export interface TelegramGateway {
  /** false while TELEGRAM_BOT_TOKEN is empty — the integration stays disabled. */
  readonly active: boolean;
  sendMessage(params: SendMessageParams): Promise<{ message_id: string }>;
  /** Only real transports support incoming updates (polling); set by the ingest service. */
  setUpdateHandler?(handler: (update: RawTelegramUpdate) => Promise<void>): void;
  /**
   * Stops the callback spinner on the user's client (feature round: inline
   * my-tickets keyboards). Informational only — real transports implement it,
   * failures are logged and never thrown.
   */
  answerCallbackQuery?(callbackQueryId: string, text?: string): Promise<void>;
}

export const TELEGRAM_GATEWAY = Symbol('TELEGRAM_GATEWAY');

/**
 * Typed Telegram API failure. `permanent` errors (403 blocked, chat not found)
 * stop retrying; everything else is retried by the sweeper with backoff.
 */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly permanent: boolean,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

/** Fire-and-forget send for informational replies (menus, prompts, lists) — never retried. */
export async function sendEphemeral(
  gateway: TelegramGateway,
  chatId: string,
  text: string,
  logger?: Logger,
  opts?: { reply_markup?: BotReplyMarkup; parse_mode?: 'HTML' },
): Promise<void> {
  if (!gateway.active) return;
  try {
    await gateway.sendMessage({ chat_id: chatId, text, ...opts });
  } catch (e) {
    logger?.warn(`ephemeral send failed (informational only): ${(e as Error).message}`);
  }
}
