import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InboxService } from '../inbox/inbox.service';
import { MessagesService } from '../messages/messages.service';
import { OrchestratorService } from '../conversation/orchestrator.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';

/**
 * The safety net — every 15 seconds and once at boot:
 *   1. stale PROCESSING inbox rows (> 2 min) go back to RECEIVED (max 3 attempts, then FAILED),
 *   2. RECEIVED rows never enqueued (crash between ingest and enqueue) are re-driven,
 *   3. PENDING/FAILED outbox messages older than 5 s are re-delivered (retry_after honored).
 */
@Injectable()
export class SweeperService implements OnModuleInit {
  private readonly logger = new Logger('Sweeper');
  private running = false;

  constructor(
    private readonly inboxService: InboxService,
    private readonly messagesService: MessagesService,
    private readonly orchestratorService: OrchestratorService,
    private readonly dispatcher: OutboxDispatcherService,
  ) {}

  async onModuleInit(): Promise<void> {
    void this.sweep('boot');
  }

  @Cron('*/15 * * * * *')
  scheduledSweep(): void {
    if (!this.running) void this.sweep('cron');
  }

  async sweep(trigger: 'boot' | 'cron'): Promise<void> {
    this.running = true;
    try {
      const requeued = await this.inboxService.requeueStale(2 * 60_000, 3);

      const received = await this.inboxService.findReceived(50);
      for (const update of received) {
        void this.orchestratorService.enqueue(update);
      }

      const due = await this.messagesService.findDueOutbox(20, { freshWindowMs: 5_000 });
      for (const message of due) {
        await this.dispatcher.deliver(message);
      }

      if (requeued > 0 || received.length > 0 || due.length > 0) {
        this.logger.log(
          `sweep(${trigger}): inbox requeued=${requeued}, received re-driven=${received.length}, outbox redelivered=${due.length}`,
        );
      }
    } catch (e) {
      this.logger.error(`sweep(${trigger}) failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
