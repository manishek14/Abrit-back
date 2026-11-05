import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { BotUpdateStage, BotUpdateStatus } from '../enums';

/**
 * bot_updates is the Telegram INBOX. The raw update is persisted FIRST
 * (point of no return — after this the message cannot be lost), the caller
 * immediately gets HTTP 200, and processing happens asynchronously.
 */
@Entity('bot_updates')
export class BotUpdate {
  /** Telegram's update_id — the PK makes dedup a single INSERT … ON CONFLICT DO NOTHING. */
  @PrimaryColumn({ type: 'bigint' })
  update_id: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'enum', enum: BotUpdateStatus, enumName: 'bot_update_status', default: BotUpdateStatus.RECEIVED })
  status: BotUpdateStatus;

  /**
   * Last completed processing milestone (CLAIMED → USER_SAVED → REPLY_SAVED).
   * Purely informational for DONE rows; for a stuck PROCESSING row it tells the
   * operator (and tests) exactly where the previous attempt died, and the
   * orchestrator resumes from there idempotently.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  stage: BotUpdateStage | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'text', nullable: true })
  last_error: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  received_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  locked_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  processed_at: Date | null;
}
