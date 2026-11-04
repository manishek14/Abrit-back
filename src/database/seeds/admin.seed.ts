import * as bcrypt from 'bcryptjs';
import { DataSource, Repository } from 'typeorm';
import { Admin } from '../entities/admin.entity';

/**
 * Ensures the first admin exists (from ADMIN_EMAIL / ADMIN_PASSWORD).
 * Idempotent: inserts only when the email is missing — it never overwrites a
 * password that was changed later, and the plaintext never touches the DB.
 */
export async function seedAdmin(ds: DataSource, email: string, password: string): Promise<void> {
  const repo: Repository<Admin> = ds.getRepository(Admin);
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await repo.findOne({ where: { email: normalizedEmail } });
  if (existing) return;

  await repo.insert({
    email: normalizedEmail,
    password_hash: bcrypt.hashSync(password, 10),
    name: 'Super Admin',
  });
}
