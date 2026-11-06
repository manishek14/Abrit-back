import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Ticket } from './ticket.entity';
import { Admin } from './admin.entity';
import { DeliveryStatus, MessageRole } from '../enums';

@Entity('messages')
export class Message {
  /** bigint identity — arrives from Postgres as a string in Node; keep it a string everywhere. */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Index('idx_messages_ticket_id_id')
  @Column({ type: 'uuid' })
  ticket_id: string;

  @Column({ type: 'enum', enum: MessageRole, enumName: 'message_role' })
  role: MessageRole;

  @Column({ type: 'text' })
  content: string;

  /**
   * Second dedup wall (the first is bot_updates.update_id being the PK):
   * a processed Telegram update can never store its user message twice.
   */
  @Index('uq_messages_telegram_update_id', { unique: true })
  @Column({ type: 'bigint', nullable: true })
  telegram_update_id: string | null;

  /**
   * At most ONE assistant reply per user message, even across retries/crashes.
   * Enforced by partial unique index (migration):
   *   CREATE UNIQUE INDEX "uq_messages_in_reply_to_assistant" ON "messages" ("in_reply_to_id")
   *     WHERE "role" = 'ASSISTANT';
   */
  @Index('uq_messages_in_reply_to_assistant', { unique: true, where: `role = 'ASSISTANT'` })
  @Column({ type: 'bigint', nullable: true })
  in_reply_to_id: string | null;

  /** Outbox delivery state — only outbound roles (ASSISTANT/ADMIN/SYSTEM) carry it. */
  @Column({ type: 'enum', enum: DeliveryStatus, enumName: 'delivery_status', nullable: true })
  delivery_status: DeliveryStatus | null;

  /**
   * Delivery lease (review fix #2): set by claimForDelivery's atomic UPDATE; a
   * concurrent sender loses the claim and skips. A crashed sender's lease
   * simply expires (now - lease) and the sweeper reclaims.
   */
  @Column({ type: 'timestamptz', nullable: true })
  claimed_at: Date | null;

  @Column({ type: 'int', default: 0 })
  delivery_attempts: number;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'bigint', nullable: true })
  telegram_message_id: string | null;

  /**
   * Operator-reply idempotency key (review fix): the panel generates one per
   * send attempt; a retry after a lost HTTP response re-uses the SAME key so
   * the partial unique index (migration) turns the duplicate INSERT into a
   * replay of the original message instead of a second Telegram delivery.
   */
  @Index('uq_messages_client_message_id', { unique: true, where: `role = 'ADMIN'` })
  @Column({ type: 'varchar', length: 64, nullable: true })
  client_message_id: string | null;

  @Column({ type: 'uuid', nullable: true })
  admin_id: string | null;

  /** Provider metadata (model, latency, fallback…) — never secrets. */
  @Column({ type: 'jsonb', nullable: true })
  meta: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  sent_at: Date | null;

  @ManyToOne(() => Ticket, (t) => t.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket: Ticket;

  @ManyToOne(() => Admin, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'admin_id' })
  admin: Admin | null;
}
