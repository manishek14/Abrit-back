import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { BotUpdate } from '../../database/entities/bot-update.entity';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { Message } from '../../database/entities/message.entity';
import { MessageRole } from '../../database/enums';
import { InboxService } from '../inbox/inbox.service';
import { MessagesService } from '../messages/messages.service';
import { TicketsService } from '../tickets/tickets.service';
import { UsersService } from '../users/users.service';
import { CommandsService, parseCommand } from './commands.service';
import { sendEphemeral, TELEGRAM_GATEWAY, TelegramGateway } from '../telegram/telegram-gateway.interface';
import { RawTelegramUpdate } from '../telegram/types';
import { REPLY_PROVIDER, ReplyProvider } from '../ai/reply-provider.interface';
import { MESSAGE_TOO_LONG_MESSAGE, ONLY_TEXT_SUPPORTED_MESSAGE } from '../../common/ticket-labels';

const MAX_USER_TEXT_LENGTH = 3000;

/**
 * The heart of the pipeline (plan §4): inbox claim → upsert user → command or
 * ticket flow → (ensure ticket) → store USER message → reply provider → outbox.
 *
 * Ordering guarantee: updates of the SAME chat are processed sequentially via a
 * per-chat promise chain, so the second message's AI context always contains the
 * first message's reply. Cross-chat updates run in parallel.
 *
 * Crash semantics: claim() flips the row to PROCESSING; on failure we simply
 * leave it there — the sweeper requeues stale rows (≤ 3 attempts), so every
 * step in here only needs to be idempotent, not transactional-with-network.
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger('Orchestrator');
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly inboxService: InboxService,
    private readonly usersService: UsersService,
    private readonly ticketsService: TicketsService,
    private readonly messagesService: MessagesService,
    private readonly commandsService: CommandsService,
    @Inject(REPLY_PROVIDER) private readonly replyProvider: ReplyProvider,
    @Inject(TELEGRAM_GATEWAY) private readonly gateway: TelegramGateway,
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
    return String(payload?.message?.chat?.id ?? `update-${update.update_id}`);
  }

  private async processSafely(update: BotUpdate): Promise<void> {
    try {
      await this.processUpdate(update);
    } catch (e) {
      // row stays PROCESSING → sweeper requeues after 2 min (≤ 3 attempts)
      this.logger.error(
        `update ${update.update_id} failed processing: ${(e as Error).message} — will be retried by sweeper`,
      );
    }
  }

  private async processUpdate(update: BotUpdate): Promise<void> {
    const claimed = await this.inboxService.claim(update.update_id);
    if (!claimed) return; // another worker owns this update

    const payload = claimed.payload as RawTelegramUpdate;
    const updateId = String(claimed.update_id);
    const msg = payload.message;

    // unsupported shapes: ignore permanently (edited_message filter is here for webhook mode)
    if (!msg || payload.edited_message) {
      await this.inboxService.markDone(updateId);
      return;
    }
    if (msg.chat?.type && msg.chat.type !== 'private') {
      await this.inboxService.markDone(updateId); // groups/channels are out of scope (plan §6)
      return;
    }
    if (msg.from?.is_bot) {
      await this.inboxService.markDone(updateId); // never process bot senders
      return;
    }

    const user = await this.usersService.upsertTelegramUser({
      telegram_id: String(msg.from?.id ?? msg.chat.id),
      chat_id: String(msg.chat.id),
      username: msg.from?.username ?? null,
      first_name: msg.from?.first_name ?? null,
      last_name: msg.from?.last_name ?? null,
      language_code: msg.from?.language_code ?? null,
    });

    if (user.is_blocked) {
      await this.inboxService.markDone(updateId); // blocked users are silently dropped
      return;
    }

    const chatId = String(msg.chat.id);
    const text = (msg.text ?? '').trim();

    if (!text) {
      await sendEphemeral(this.gateway, chatId, ONLY_TEXT_SUPPORTED_MESSAGE, this.logger);
      await this.inboxService.markDone(updateId);
      return;
    }
    if (text.length > MAX_USER_TEXT_LENGTH) {
      await sendEphemeral(this.gateway, chatId, MESSAGE_TOO_LONG_MESSAGE, this.logger);
      await this.inboxService.markDone(updateId);
      return;
    }

    const command = parseCommand(text);
    if (command) {
      await this.commandsService.handle(user, chatId, command);
      await this.inboxService.markDone(updateId);
      return;
    }

    // ── plain text → ticket flow ─────────────────────────────────────────────
    const { ticket, created } = await this.ticketsService.ensureActiveTicket(
      user.id,
      text.slice(0, 60),
    );
    if (created) {
      // plan §6 rule 1: announce auto-created tickets durably
      await this.messagesService.addOutboundMessage({
        ticket_id: ticket.id,
        role: MessageRole.SYSTEM,
        content: `تیکت ${ticket.ticket_number} ایجاد شد.`,
      });
    }

    let userMessage: Message;
    try {
      userMessage = await this.messagesService.addUserMessage({
        ticket_id: ticket.id,
        content: text,
        telegram_update_id: updateId,
      });
    } catch (e) {
      if (e instanceof ConflictException) {
        // this update's message was already stored before a crash — done, no double reply
        await this.inboxService.markDone(updateId);
        return;
      }
      throw e;
    }

    const reply = await this.replyProvider.reply({ ticket, userMessage });
    try {
      await this.messagesService.addOutboundMessage({
        ticket_id: ticket.id,
        role: MessageRole.ASSISTANT,
        content: reply.content,
        in_reply_to_id: userMessage.id,
        meta: reply.meta ?? null,
      });
    } catch (e) {
      if (e instanceof ConflictException) {
        // assistant already replied to this user message (retry after crash) — fine
      } else {
        throw e;
      }
    }

    await this.inboxService.markDone(updateId);
  }
}
