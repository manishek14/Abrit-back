import { Column, CreateDateColumn, Entity, Index, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Ticket } from './ticket.entity';

@Entity('telegram_users')
export class TelegramUser {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Telegram user id — bigint comes back from Postgres as a string in Node; keep it a string everywhere. */
  @Index('uq_telegram_users_telegram_id', { unique: true })
  @Column({ type: 'bigint' })
  telegram_id: string;

  /**
   * Chat id kept SEPARATELY from telegram_id (project owner's requirement).
   * In private chats they are equal today, but storing the chat id independently
   * makes future group/channel support trivial and keeps Telegram API sends simple.
   */
  @Column({ type: 'bigint', nullable: true })
  chat_id: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  username: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  first_name: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  last_name: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  language_code: string | null;

  @Column({ type: 'boolean', default: false })
  is_blocked: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  last_seen_at: Date | null;

  @OneToMany(() => Ticket, (t) => t.user)
  tickets: Ticket[];
}
