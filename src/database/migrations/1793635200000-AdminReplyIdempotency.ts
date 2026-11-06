import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Review fix — idempotent operator replies:
 * messages.client_message_id carries the panel's per-send idempotency key.
 * A retry after a lost HTTP response (timeout, network drop) re-POSTs with
 * the SAME key; the partial unique index below makes the second insert
 * impossible, so the user in Telegram can never receive a duplicated reply.
 *
 * Partial (WHERE role = 'ADMIN') so no other message kind is constrained.
 */
export class AdminReplyIdempotency1793635200000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "messages" ADD COLUMN "client_message_id" varchar(64)`);
    await qr.query(
      `CREATE UNIQUE INDEX "uq_messages_client_message_id" ON "messages" ("client_message_id") WHERE "role" = 'ADMIN'`,
    );
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS "uq_messages_client_message_id"`);
    await qr.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "client_message_id"`);
  }
}
