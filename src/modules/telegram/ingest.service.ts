import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { InboxService } from '../inbox/inbox.service';
import { OrchestratorService } from '../conversation/orchestrator.service';
import { TELEGRAM_GATEWAY, TelegramGateway } from './telegram-gateway.interface';
import { RawTelegramUpdate } from './types';
import { isValidUpdateShape } from './update-shape';

/**
 * The single entry point for incoming Telegram updates (polling handler or the
 * webhook controller both land here): validate the payload's SHAPE → store in
 * the inbox → 200 → async process. After the insert the message can no longer
 * be lost; everything else is retryable.
 */
@Injectable()
export class IngestService implements OnModuleInit {
  constructor(
    private readonly inboxService: InboxService,
    private readonly orchestratorService: OrchestratorService,
    @Inject(TELEGRAM_GATEWAY) private readonly gateway: TelegramGateway,
  ) {}

  onModuleInit(): void {
    this.gateway.setUpdateHandler?.((update) =>
      this.handleIncoming(update).then(() => undefined),
    );
  }

  async handleIncoming(update: RawTelegramUpdate): Promise<{ stored: boolean }> {
    // review fix #4-c: reject malformed payloads BEFORE storing them — the
    // webhook answers 400 and nothing unprocessable ever reaches the inbox.
    if (!isValidUpdateShape(update)) {
      throw new BadRequestException('Malformed Telegram update payload');
    }
    const stored = await this.inboxService.ingest(
      String(update.update_id),
      update as Record<string, unknown>,
    );
    if (!stored) return { stored: false }; // duplicate delivery — nothing to do
    void this.orchestratorService.enqueue(stored);
    return { stored: true };
  }
}
