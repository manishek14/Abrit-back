import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Review round 5 fix — real retry backoff for the outbox:
 * messages.next_attempt_at schedules the NEXT delivery attempt after a
 * transient failure (exponential backoff with jitter, computed by
 * MessagesService.computeRetryBackoffMs). Previously a FAILED message was
 * re-picked by the 15-second sweeper immediately, so a 2-minute Telegram
 * outage exhausted all 5 attempts in about a minute and the message was
 * lost from the retry cycle forever. Existing rows keep NULL (= immediately
 * due), which preserves the previous behavior for whatever the sweeper
 * finds pending at migration time.
 */
export class OutboxRetryBackoff1793721600000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "messages" ADD COLUMN "next_attempt_at" timestamptz`);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "next_attempt_at"`);
  }
}
