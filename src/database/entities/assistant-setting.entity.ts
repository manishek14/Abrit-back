import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** The assistant settings table holds exactly ONE row (id = 1, enforced by a CHECK constraint in the migration). */
export const ASSISTANT_SETTINGS_SINGLETON_ID = 1;

/**
 * Assistant settings — read from the DB on every AI call (no cache) so panel
 * changes apply instantly. is_active=false switches the bot to a fixed reply.
 */
@Entity('assistant_settings')
export class AssistantSetting {
  @PrimaryColumn({ type: 'smallint' })
  id: number;

  @Column({ type: 'text' })
  system_prompt: string;

  @Column({ type: 'varchar', length: 128 })
  model: string;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @Column({ type: 'uuid', nullable: true })
  updated_by_admin_id: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
