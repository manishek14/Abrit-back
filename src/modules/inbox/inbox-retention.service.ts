import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { BotUpdate } from '../../database/entities/bot-update.entity';
import { getEnv } from '../../config/env';

/**
 * Review fix (data retention): bot_updates keeps the RAW Telegram payloads,
 * which are only needed for crash-recovery replays. Policy (simple by design):
 *   - raw inbox rows older than BOT_UPDATES_RETENTION_DAYS (default 30) are
 *     deleted daily at 04:00 and once at boot,
 *   - conversation messages (the actual ticket history) are kept forever,
 *   - 0 disables the purge entirely.
 */
@Injectable()
export class InboxRetentionService implements OnModuleInit {
  private readonly logger = new Logger('InboxRetention');

  constructor(
    @InjectRepository(BotUpdate) private readonly repo: Repository<BotUpdate>,
  ) {}

  onModuleInit(): void {
    void this.run('boot');
  }

  /** Daily at 04:00 (server timezone). */
  @Cron('0 0 4 * * *')
  scheduledPurge(): void {
    void this.run('cron');
  }

  async run(trigger: 'boot' | 'cron'): Promise<number> {
    const days = getEnv().BOT_UPDATES_RETENTION_DAYS;
    if (days <= 0) return 0;

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await this.repo.delete({ received_at: LessThan(cutoff) });
    const removed = result.affected ?? 0;

    if (removed > 0) {
      this.logger.log(
        `retention(${trigger}): purged ${removed} inbox rows older than ${days} day(s)`,
      );
    }
    return removed;
  }
}
