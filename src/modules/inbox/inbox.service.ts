import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { BotUpdate } from '../../database/entities/bot-update.entity';
import { BotUpdateStatus } from '../../database/enums';

/**
 * Telegram inbox (bot_updates). Ingest is INSERT … ON CONFLICT DO NOTHING — a
 * duplicate update_id simply inserts nothing (caller answers 200 and moves on).
 * claim() is the atomic transition RECEIVED → PROCESSING so two workers can
 * never process the same update.
 */
@Injectable()
export class InboxService {
  constructor(
    @InjectRepository(BotUpdate) private readonly repo: Repository<BotUpdate>,
  ) {}

  /** Returns the new row, or null when this update_id already exists (duplicate). */
  async ingest(update_id: string, payload: Record<string, unknown>): Promise<BotUpdate | null> {
    const rows = await this.repo.query(
      `INSERT INTO bot_updates (update_id, payload, status)
       VALUES ($1, $2, 'RECEIVED')
       ON CONFLICT (update_id) DO NOTHING
       RETURNING *`,
      [update_id, JSON.stringify(payload)],
    );
    return (rows[0] as BotUpdate | undefined) ?? null;
  }

  /** Atomic claim — 0 rows means another worker owns this update. */
  async claim(update_id: string): Promise<BotUpdate | null> {
    const rows = await this.repo.query(
      `UPDATE bot_updates
         SET status = 'PROCESSING', locked_at = now(), attempts = attempts + 1
       WHERE update_id = $1 AND status = 'RECEIVED'
       RETURNING *`,
      [update_id],
    );
    return (rows[0] as BotUpdate | undefined) ?? null;
  }

  async markDone(update_id: string): Promise<void> {
    await this.repo.update(
      { update_id },
      { status: BotUpdateStatus.DONE, processed_at: new Date() },
    );
  }

  async markFailed(update_id: string, error: string): Promise<void> {
    await this.repo.update(
      { update_id },
      {
        status: BotUpdateStatus.FAILED,
        last_error: error.slice(0, 500),
        processed_at: new Date(),
      },
    );
  }

  /**
   * Crash recovery (sweeper): PROCESSING rows stuck longer than `staleMs`
   * go back to RECEIVED while attempts < maxAttempts, otherwise become FAILED.
   */
  async requeueStale(staleMs: number, maxAttempts: number): Promise<number> {
    const requeued = await this.repo.query(
      `UPDATE bot_updates SET status='RECEIVED', locked_at=NULL
        WHERE status='PROCESSING'
          AND locked_at < now() - make_interval(ms => $1::int)
          AND attempts < $2::int`,
      [staleMs, maxAttempts],
    );
    const failed = await this.repo.query(
      `UPDATE bot_updates SET status='FAILED', last_error='abandoned: stale lock after max attempts'
        WHERE status='PROCESSING'
          AND locked_at < now() - make_interval(ms => $1::int)
          AND attempts >= $2::int`,
      [staleMs, maxAttempts],
    );
    return (requeued.rowCount ?? 0) + (failed.rowCount ?? 0);
  }

  async findReceived(limit = 50): Promise<BotUpdate[]> {
    return this.repo.find({
      where: { status: BotUpdateStatus.RECEIVED },
      order: { received_at: 'ASC' },
      take: limit,
    });
  }
}
