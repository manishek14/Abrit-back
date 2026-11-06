import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { BotUpdate } from '../../database/entities/bot-update.entity';
import { BotUpdateStage, BotUpdateStatus } from '../../database/enums';
import { firstRawRow } from '../../common/utils/raw-rows';

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
    return firstRawRow<BotUpdate>(rows);
  }

  /** Atomic claim — 0 rows means another worker owns this update. */
  async claim(update_id: string): Promise<BotUpdate | null> {
    const rows = await this.repo.query(
      `UPDATE bot_updates
         SET status = 'PROCESSING', locked_at = now(), attempts = attempts + 1, stage = 'CLAIMED'
       WHERE update_id = $1 AND status = 'RECEIVED'
       RETURNING *`,
      [update_id],
    );
    return firstRawRow<BotUpdate>(rows);
  }

  /** Records the last completed milestone (review fix #1) for observability + resume. */
  async setStage(update_id: string, stage: BotUpdateStage): Promise<void> {
    await this.repo.update({ update_id }, { stage });
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
   * Review fix #4-b: processing errors are now PERSISTED on the row (status
   * stays PROCESSING so the sweeper still retries; last_error + attempts make
   * the failure observable in the database instead of only in logs).
   */
  async recordError(update_id: string, error: string): Promise<void> {
    await this.repo.update(
      { update_id },
      { last_error: error.slice(0, 500) },
    );
  }

  /**
   * Crash recovery (sweeper): PROCESSING rows stuck longer than `staleMs`
   * go back to RECEIVED while attempts < maxAttempts, otherwise become FAILED.
   */
  async requeueStale(staleMs: number, maxAttempts: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleMs);

    const requeued = await this.repo
      .createQueryBuilder()
      .update()
      .set({ status: BotUpdateStatus.RECEIVED, locked_at: null })
      .where("status = 'PROCESSING' AND locked_at < :cutoff", { cutoff })
      .andWhere('attempts < :max', { max: maxAttempts })
      .execute();

    // keep the REAL last error if one was recorded — do not overwrite it
    const failed = await this.repo
      .createQueryBuilder()
      .update()
      .set({
        status: BotUpdateStatus.FAILED,
        last_error: () => `COALESCE(NULLIF(bot_updates.last_error, ''), 'abandoned: stale lock after max attempts')`,
      })
      .where("status = 'PROCESSING' AND locked_at < :cutoff", { cutoff })
      .andWhere('attempts >= :max', { max: maxAttempts })
      .execute();

    return (requeued.affected ?? 0) + (failed.affected ?? 0);
  }

  /**
   * PER-CHAT ORDERING GATE (review fix): does an EARLIER update of the same
   * chat exist that has not reached a terminal state yet (DONE / FAILED)?
   *
   * The in-process promise queue alone breaks order after a processing
   * failure: the failed update's promise RESOLVES (the error is swallowed),
   * so the next update would run immediately while the sweeper retries the
   * first one minutes later — the second reply could reach the user BEFORE
   * the first. The orchestrator therefore asks this BEFORE claiming: while a
   * predecessor is unfinished the row is simply left RECEIVED (attempts are
   * NOT consumed) and the sweeper re-drives it once the blocker is terminal.
   */
  async hasEarlierUnfinished(chatId: string, updateId: string): Promise<boolean> {
    const rows = await this.repo.query(
      `SELECT 1
         FROM bot_updates
        WHERE status NOT IN ('DONE', 'FAILED')
          AND update_id < $2::bigint
          AND payload -> 'message' -> 'chat' ->> 'id' = $1
        LIMIT 1`,
      [chatId, updateId],
    );
    return rows.length > 0;
  }

  async findReceived(limit = 50): Promise<BotUpdate[]> {
    return this.repo.find({
      where: { status: BotUpdateStatus.RECEIVED },
      order: { received_at: 'ASC' },
      take: limit,
    });
  }
}
