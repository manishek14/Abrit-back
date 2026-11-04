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
 * message.created event) and again from the sweeper for retries. Semantics are
 * at-least-once: a rare crash between a successful send and the SENT update can
 * duplicate one message (documented limitation, plan §15).
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
    const ticket = await this.ticketsService.findById(message.ticket_id);
    if (!ticket) {
      await this.messagesService.markPermanentlyFailed(message.id, 'ticket no longer exists');
      return;
    }
    const user = await this.usersService.findByIdOrNull(ticket.user_id);
    if (!user) {
      await this.messagesService.markPermanentlyFailed(message.id, 'ticket user missing');
      return;
    }
    if (user.is_blocked) {
      await this.messagesService.markPermanentlyFailed(message.id, 'user blocked the bot');
      return;
    }

    const chatId = user.chat_id || user.telegram_id;
    try {
      let firstMessageId: string | null = null;
      for (const chunk of splitForTelegram(message.content)) {
        const res = await this.gateway.sendMessage({ chat_id: chatId, text: chunk });
        firstMessageId ??= res.message_id;
      }
      await this.messagesService.markSent(message.id, firstMessageId);
    } catch (e) {
      if (e instanceof TelegramApiError) {
        if (e.code === 403) {
          // user blocked the bot — never retry, flag the user (seed users take this path too)
          await this.usersService.setBlocked(user.id, true);
          await this.messagesService.markPermanentlyFailed(message.id, e.message);
          return;
        }
        if (e.permanent) {
          await this.messagesService.markPermanentlyFailed(message.id, e.message);
          return;
        }
        if (e.retryAfterSeconds && e.retryAfterSeconds > 0) {
          await this.messagesService.deferRetry(message.id, e.retryAfterSeconds);
          return;
        }
        await this.messagesService.markFailed(message.id, e.message);
        return;
      }
      await this.messagesService.markFailed(message.id, (e as Error).message);
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
