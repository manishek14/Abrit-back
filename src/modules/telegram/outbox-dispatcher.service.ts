import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Message } from '../../database/entities/message.entity';
import { DeliveryStatus, MessageRole } from '../../database/enums';
import { MessagesService } from '../messages/messages.service';
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
 *   - the ONE residual window is a hard crash between a successful Telegram
 *     send of ANY chunk and its recordChunkSent commit — that single chunk can
 *     be re-sent once on recovery. Exactly-once across an unacknowledged
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
          // user blocked the bot — never retry, flag the user (seed users take this path too)
          await this.usersService.setBlocked(user.id, true);
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
        await this.messagesService.markFailed(claimed.id, e.message, claimToken);
        return;
      }
      await this.messagesService.markFailed(claimed.id, (e as Error).message, claimToken);
    }
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
