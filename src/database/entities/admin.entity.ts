import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('admins')
export class Admin {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('uq_admins_email', { unique: true })
  @Column({ type: 'varchar', length: 255 })
  email: string;

  /** bcrypt hash — the plaintext password never touches the DB or logs. */
  @Column({ type: 'varchar', length: 255 })
  password_hash: string;

  @Column({ type: 'varchar', length: 128 })
  name: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
