import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Review fixes #1 and #2:
 *  - bot_updates.stage: explicit processing milestone (CLAIMED → USER_SAVED →
 *    REPLY_SAVED) so a crashed run can be resumed (and inspected) precisely,
 *  - messages.claimed_at: delivery lease for the outbox — an atomic
 *    PENDING→claimed transition prevents the immediate dispatcher and the
 *    sweeper from ever sending the same message twice.
 */
export class ResumableProcessingAndOutboxClaim1793568000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "bot_updates" ADD COLUMN "stage" varchar(32)`);
    await qr.query(`ALTER TABLE "messages" ADD COLUMN "claimed_at" timestamptz`);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "claimed_at"`);
    await qr.query(`ALTER TABLE "bot_updates" DROP COLUMN IF EXISTS "stage"`);
  }
}
