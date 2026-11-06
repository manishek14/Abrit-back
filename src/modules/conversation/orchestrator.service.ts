import { Inject, Injectable, Logger } from '@nestjs/common';
import { BotUpdate } from '../../database/entities/bot-update.entity';
import { InboxService } from '../inbox/inbox.service';
import { FlowRouterService } from './flow-router.service';
import { RawTelegramUpdate } from '../telegram/types';

/**
 * The heart of the pipeline: inbox claim → FlowRouter. Ordering, resumability
 * and crash semantics are UNCHANGED from the reviewed design:
 *
 *  - the in-process per-chat promise chain serializes updates of the SAME
 *    chat, and when a predecessor FAILS processing, every later update of
 *    that chat is held at the DB-level ORDERING GATE (InboxService
 *    .hasEarlierUnfinished) until the predecessor reaches a terminal state;
 *  - every processing step is idempotent and the sweeper requeues stuck
 *    PROCESSING rows (≤ 3 attempts), so "stored but unanswered" cannot happen;
 *  - callbacks now join the SAME per-chat ordering as messages (their embedded
 *    message's chat id is the key), so a button press can never overtake a
 *    pending message of the same chat.
 *
 * WHAT changed in the feature round is only ROUTING: the monolithic
 * "plain text ⇒ auto-ticket + AI reply" logic (the reported bug) moved into
 * the FlowRouter state machine (registration → wizard → view/reply → general
 * chat), see flow-router.service.ts.
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger('Orchestrator');
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly inboxService: InboxService,
    private readonly flowRouter: FlowRouterService,
  ) {}

  /** Enqueues an update into its chat's serial queue (in-process, single instance). */
  enqueue(update: BotUpdate): Promise<void> {
    const chatKey = this.chatKey(update);
    const prev = this.queues.get(chatKey) ?? Promise.resolve();
    const run = prev.then(() => this.processSafely(update));
    this.queues.set(chatKey, run);
    void run.finally(() => {
      if (this.queues.get(chatKey) === run) this.queues.delete(chatKey);
    });
    return run;
  }

  private chatKey(update: BotUpdate): string {
    const payload = update.payload as Partial<RawTelegramUpdate>;
    return String(
      payload?.message?.chat?.id ?? payload?.callback_query?.message?.chat?.id ?? `update-${update.update_id}`,
    );
  }

  private async processSafely(update: BotUpdate): Promise<void> {
    try {
      await this.processUpdate(update);
    } catch (e) {
      // row stays PROCESSING → sweeper requeues after 2 min (≤ 3 attempts)
      const error = e as Error;
      this.logger.error(
        `update ${update.update_id} failed processing: ${error.message} — will be retried by sweeper`,
      );
      // persist the failure reason on the row (status stays PROCESSING on
      // purpose — the sweeper still owns the retry policy)
      try {
        await this.inboxService.recordError(String(update.update_id), error.message);
      } catch (recordError) {
        this.logger.warn(`could not record error for update ${update.update_id}`);
      }
    }
  }

  private async processUpdate(update: BotUpdate): Promise<void> {
    const payload = update.payload as RawTelegramUpdate;
    const updateId = String(update.update_id);

    // ── unsupported shapes: ignore permanently — these paths never produce
    // chat content, so they take no part in per-chat ordering.
    if (!payload.message && !payload.callback_query) {
      return void (await this.claimAndMarkDone(updateId));
    }
    if (payload.edited_message) return void (await this.claimAndMarkDone(updateId));
    if (payload.message && payload.message.chat?.type && payload.message.chat.type !== 'private') {
      return void (await this.claimAndMarkDone(updateId)); // groups/channels are out of scope
    }
    if (
      (payload.message?.from?.is_bot) ||
      (payload.callback_query?.from?.is_bot)
    ) {
      return void (await this.claimAndMarkDone(updateId)); // never process bot senders
    }

    const chatId = String(
      payload.message?.chat?.id ?? payload.callback_query?.message?.chat?.id ?? '',
    );

    // ── ORDERING GATE — while an EARLIER update of THIS chat is still
    // unfinished (not DONE and not FAILED), this update must wait (see the
    // class docstring). Waiting is free — the row stays RECEIVED and is
    // RE-DRIVEN twice: a fast in-process timer (the predecessor usually
    // finishes within milliseconds — markDone races the user's next message)
    // and the sweeper as the safety net.
    if (await this.inboxService.hasEarlierUnfinished(chatId, updateId)) {
      this.logger.log(
        `update ${updateId} waits: an earlier update of chat ${chatId} is still unfinished`,
      );
      this.scheduleGateRetry(update);
      return;
    }

    const claimed = await this.inboxService.claim(update.update_id);
    if (!claimed) return; // another worker owns this update

    await this.flowRouter.route(claimed);
  }

  /** Shapes that are permanently ignored: claim (dedup vs other workers) then
   *  mark DONE — no ordering involvement, they never produce chat content. */
  private async claimAndMarkDone(updateId: string): Promise<void> {
    const claimed = await this.inboxService.claim(updateId);
    if (claimed) await this.inboxService.markDone(updateId);
  }

  /**
   * Fast gate re-drive: a held update is re-enqueued locally after a short
   * delay instead of waiting up to 15 s for the sweeper. Safe by construction:
   * the row stays RECEIVED (claim dedups vs the sweeper/other workers) and the
   * re-run just re-checks the gate. Bounded to a dozen attempts (~4 s) — after
   * that the 15 s sweeper remains the safety net; the timer is unref'd so it
   * never keeps the process alive.
   */
  private readonly gateRetries = new Map<string, number>();
  private scheduleGateRetry(update: BotUpdate, delayMs = 300): void {
    const key = String(update.update_id);
    const count = (this.gateRetries.get(key) ?? 0) + 1;
    this.gateRetries.set(key, count);
    if (count > 12) return; // give up locally — the sweeper owns it now
    const timer = setTimeout(() => {
      this.gateRetries.delete(key);
      void this.enqueue(update);
    }, delayMs);
    timer.unref?.();
  }
}
