import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Message } from '../../database/entities/message.entity';
import { DeliveryStatus, MessageRole } from '../../database/enums';
import {
  MessagesService,
  computeRetryBackoffMs,
} from '../messages/messages.service';
import { TicketsService } from '../tickets/tickets.service';
import { UsersService } from '../users/users.service';
import { EventsService } from '../../common/events/events.service';
import { TELEGRAM_GATEWAY, TelegramApiError, TelegramGateway } from './telegram-gateway.interface';

const TELEGRAM_TEXT_LIMIT = 4000;

/** Outbound roles that go through the durable outbox. */
export function isOutboundPending(m: Message): boolean {
  return m.delivery_status === DeliveryStatus.PENDING && m.role !== MessageRole.USER;
}

/**
 * Delivers outbox messages to Telegram: immediately after commit (via the
 * message.created event) and again from the sweeper for retries. Every send
 * is guarded by an ATOMIC claim (claimForDelivery) with a 60 s lease, so the
 * immediate path and the sweeper can never deliver the same message twice —
 * even without a crash. Multi-part messages record per-chunk progress in
 * meta (sent_chunks), so a failed/retried send resumes at the first UNSENT
 * chunk instead of duplicating already-delivered parts.
 *
 * Delivery semantics are honestly AT-LEAST-ONCE (review fix — doc + hardening):
 *   - concurrent duplicate sends are impossible (atomic claim);
 *   - the claim consumes the attempt counter at claim time, so a hard crash
 *     between claim and bookkeeping still burns a retry (bounded crash loops);
 *   - all outcome writes (chunk progress, SENT, FAILED, deferral) are FENCED
 *     by the claim token: a zombie sender whose lease expired mid-send writes
 *     0 rows and ABORTS as soon as it notices, instead of racing the new owner;
 *   - the lease is actively RENEWED before every chunk send (review round 5)
 *     and the Telegram request itself is bounded by TELEGRAM_SEND_TIMEOUT_MS
 *     (< the 60 s lease), so a slow-but-alive sender can no longer have its
 *     lease expire mid-flight — the previous "worker 1 still sending while the
 *     sweeper re-claims and worker 2 double-sends" window is closed;
 *   - TRANSIENT failures schedule the next attempt with exponential backoff +
 *     jitter (next_attempt_at) instead of retrying on the next 15 s sweep;
 *     PERMANENT errors (403, chat not found, …) stop retrying immediately;
 *   - the ONE residual window is a hard crash — or a client-side timeout of a
 *     request that Telegram actually completes — between the external send of
 *     ANY chunk and its recordChunkSent commit: that single chunk can be
 *     re-sent once on recovery. Exactly-once across an unacknowledged
 *     external call is impossible; claiming otherwise would be dishonest.
 */
@Injectable()
export class OutboxDispatcherService implements OnModuleInit {
  private readonly logger = new Logger('OutboxDispatcher');

  constructor(
    private readonly messagesService: MessagesService,
    private readonly ticketsService: TicketsService,
    private readonly usersService: UsersService,
    private readonly events: EventsService,
    @Inject(TELEGRAM_GATEWAY) private readonly gateway: TelegramGateway,
  ) {}

  onModuleInit(): void {
    this.events.on('message.created', ({ message }) => {
      if (isOutboundPending(message)) {
        void this.deliver(message).catch((e) =>
          this.logger.warn(
            `immediate delivery failed for message ${message.id} (sweeper will retry): ${(e as Error).message}`,
          ),
        );
      }
    });
    // Manual panel retry (review round 5): the operator re-armed a FAILED
    // message — deliver it NOW instead of waiting for the sweeper.
    this.events.on('message.retry_requested', ({ message }) => {
      if (isOutboundPending(message)) {
        void this.deliver(message).catch((e) =>
          this.logger.warn(
            `manual retry failed for message ${message.id} (sweeper will retry): ${(e as Error).message}`,
          ),
        );
      }
    });
  }

  async deliver(message: Message): Promise<void> {
    // Review fix #2: atomic claim FIRST — exactly one of {immediate dispatcher,
    // sweeper, stale-lease recovery} owns this send; the losers return quietly.
    const claimed = await this.messagesService.claimForDelivery(message.id);
    if (!claimed) return;

    // FENCING (review fix): every outcome write below is fenced by this token —
    // if our lease expires mid-send and another worker re-claims the row, our
    // writes match 0 rows and we abort as soon as we notice.
    const claimToken = MessagesService.readClaimToken(claimed);

    const ticket = await this.ticketsService.findById(claimed.ticket_id);
    if (!ticket) {
      await this.messagesService.markPermanentlyFailed(claimed.id, 'ticket no longer exists', claimToken);
      return;
    }
    const user = await this.usersService.findByIdOrNull(ticket.user_id);
    if (!user) {
      await this.messagesService.markPermanentlyFailed(claimed.id, 'ticket user missing', claimToken);
      return;
    }
    if (user.is_blocked) {
      await this.messagesService.markPermanentlyFailed(claimed.id, 'user blocked the bot', claimToken);
      return;
    }

    const chatId = user.chat_id || user.telegram_id;
    // Multi-part resume (review fix): how many chunks the PREVIOUS attempt
    // already delivered is committed to meta after each successful send, so a
    // retry continues at the first UNSENT chunk — already-delivered parts are
    // never re-sent to the user.
    const { sentChunks, firstTelegramMessageId: storedFirstId } =
      MessagesService.readChunkProgress(claimed);
    const chunks = splitForTelegram(claimed.content);

    // Every chunk was delivered but the process died before markSent — finish
    // the bookkeeping without a single new Telegram call.
    if (sentChunks >= chunks.length) {
      await this.messagesService.markSent(claimed.id, storedFirstId, claimToken);
      return;
    }

    try {
      let firstMessageId: string | null = storedFirstId;
      for (let i = sentChunks; i < chunks.length; i++) {
        // LEASE RENEWAL (review round 5 fix #2): refresh the lease BEFORE every
        // chunk's network call. A send is bounded by TELEGRAM_SEND_TIMEOUT_MS
        // (< the 60 s lease), so the renewed lease always covers the request —
        // the sweeper can never re-claim a message we are still sending.
        const renewed = await this.messagesService.renewDeliveryClaim(claimed.id, claimToken);
        if (!renewed) {
          // Same fence semantics as a lost progress write: another worker owns
          // the row now — abort instead of racing it.
          this.logger.warn(
            `lost the delivery claim for message ${claimed.id} before chunk ${i + 1} — aborting (new owner took over)`,
          );
          return;
        }
        const res = await this.gateway.sendMessage({ chat_id: chatId, text: chunks[i] });
        firstMessageId ??= res.message_id; // first chunk's id anchors the reply
        // durable progress: a crash right after this line resumes at i + 1
        const stillOwner = await this.messagesService.recordChunkSent(
          claimed.id,
          i + 1,
          firstMessageId,
          claimToken,
        );
        if (!stillOwner) {
          // FENCING (review fix): our lease expired and another worker re-claimed
          // the message mid-send. Stop immediately — the new owner continues
          // from the durable per-chunk progress; continuing would race it.
          this.logger.warn(
            `lost the delivery claim for message ${claimed.id} after chunk ${i + 1} — aborting (new owner took over)`,
          );
          return;
        }
      }
      await this.messagesService.markSent(claimed.id, firstMessageId, claimToken);
    } catch (e) {
      if (e instanceof TelegramApiError) {
        if (e.code === 403) {
          // RACE-SAFE BLOCKING (review round 5 fix #4): flag the user as blocked
          // ONLY when no incoming message newer than our claim exists. The user
          // processing path bumps last_seen_at on EVERY fresh message — so a
          // user who unblocked the bot and already sent a new message (while an
          // old send was still in flight) must NOT be re-blocked by the stale
          // 403 arriving late. The orchestrator's blocked-recovery path re-arms
          // a still-blocked reality on the next message either way.
          const claimedAt = claimed.claimed_at ? new Date(claimed.claimed_at) : new Date();
          await this.usersService.setBlockedIfNoNewerActivity(user.id, claimedAt);
          await this.messagesService.markPermanentlyFailed(claimed.id, e.message, claimToken);
          return;
        }
        if (e.permanent) {
          await this.messagesService.markPermanentlyFailed(claimed.id, e.message, claimToken);
          return;
        }
        if (e.retryAfterSeconds && e.retryAfterSeconds > 0) {
          await this.messagesService.deferRetry(claimed.id, e.retryAfterSeconds, claimToken);
          return;
        }
        await this.markTransientFailure(claimed, e.message, claimToken);
        return;
      }
      // Non-Telegram errors (network, timeout, DNS…) are transient by
      // definition — schedule a real backoff instead of an immediate sweep
      // retry (review round 5 fix #1).
      await this.markTransientFailure(claimed, (e as Error).message, claimToken);
    }
  }

  /** FAILED + next_attempt_at = now + exponential backoff(± jitter). The claim
   *  row's delivery_attempts is the POST-claim counter (1-based) — exactly the
   *  input computeRetryBackoffMs expects for the failed attempt. */
  private async markTransientFailure(
    claimed: Message,
    error: string,
    claimToken: string,
  ): Promise<void> {
    const delay = computeRetryBackoffMs(claimed.delivery_attempts);
    await this.messagesService.markFailed(
      claimed.id,
      error,
      claimToken,
      new Date(Date.now() + delay),
    );
    this.logger.log(
      `message ${claimed.id} failed transiently (attempt ${claimed.delivery_attempts}) — next attempt in ~${Math.round(delay / 1000)}s`,
    );
  }
}

/** Telegram hard limit is 4096 — cut on newlines when possible, slightly below the cap. */
export function splitForTelegram(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
