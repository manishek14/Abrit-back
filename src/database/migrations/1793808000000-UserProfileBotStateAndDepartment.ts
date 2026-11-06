import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Feature round — mandatory user profiles, per-user bot state and ticket departments:
 *
 *  - telegram_users.full_name / phone / profile_completed_at: the two-step
 *    registration (name → phone) writes here; `profile_completed_at IS NOT NULL`
 *    is the completion flag (auditable, unlike a bare boolean).
 *  - telegram_users.bot_state: the conversation state machine (registration
 *    step, ticket-wizard step, ticket view/reply context, general-chat
 *    history). DB-backed instead of in-memory so a restart (or a sweeper
 *    requeue) can never silently drop what step the user was in; the service
 *    layer enforces a TTL so stale state cannot linger forever.
 *  - tickets.department: the department chosen in the wizard (FINANCE /
 *    SUPPORT / TECHNICAL / SUGGESTIONS). varchar + CHECK (not a PG enum) so
 *    future additions need a trivial migration, and legacy rows stay NULL.
 *
 * Additive only — no existing column changes, no data migration needed.
 */
export class UserProfileBotStateAndDepartment1793808000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(
      `ALTER TABLE "telegram_users"
         ADD COLUMN "full_name" varchar(120),
         ADD COLUMN "phone" varchar(20),
         ADD COLUMN "profile_completed_at" timestamptz,
         ADD COLUMN "bot_state" jsonb`,
    );
    await qr.query(
      `ALTER TABLE "tickets"
         ADD COLUMN "department" varchar(32),
         ADD CONSTRAINT "chk_tickets_department"
           CHECK ("department" IS NULL OR "department" IN ('FINANCE', 'SUPPORT', 'TECHNICAL', 'SUGGESTIONS'))`,
    );
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "tickets" DROP CONSTRAINT IF EXISTS "chk_tickets_department"`);
    await qr.query(`ALTER TABLE "tickets" DROP COLUMN IF EXISTS "department"`);
    await qr.query(
      `ALTER TABLE "telegram_users"
         DROP COLUMN IF EXISTS "bot_state",
         DROP COLUMN IF EXISTS "profile_completed_at",
         DROP COLUMN IF EXISTS "phone",
         DROP COLUMN IF EXISTS "full_name"`,
    );
  }
}
