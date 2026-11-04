import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { BotUpdateStatus } from '../enums';

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
