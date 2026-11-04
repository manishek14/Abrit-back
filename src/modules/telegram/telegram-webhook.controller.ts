import { Body, Controller, ForbiddenException, Headers, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { IngestService } from './ingest.service';
import { RawTelegramUpdate } from './types';

export const TELEGRAM_WEBHOOK_SECRET = Symbol('TELEGRAM_WEBHOOK_SECRET');

/**
 * POST /api/telegram/webhook — public (no JWT), authenticated by the dedicated
 * Telegram secret token header, compared in constant time. Responds 200 as
 * soon as the update is persisted; Telegram never waits for the AI.
 */
@Controller('telegram')
export class TelegramWebhookController {
  constructor(
    private readonly ingest: IngestService,
    @Inject(TELEGRAM_WEBHOOK_SECRET) private readonly webhookSecret: string,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Headers('x-telegram-bot-api-secret-token') received: string | undefined,
    @Body() update: unknown,
  ): Promise<{ ok: boolean }> {
    if (!this.secretMatches(received)) {
      throw new ForbiddenException('Invalid webhook secret');
    }
    await this.ingest.handleIncoming(update as RawTelegramUpdate);
    return { ok: true };
  }

  private secretMatches(received: string | undefined): boolean {
    if (!received || !this.webhookSecret) return false;
    const a = createHash('sha256').update(received).digest();
    const b = createHash('sha256').update(this.webhookSecret).digest();
    return timingSafeEqual(a, b);
  }
}
