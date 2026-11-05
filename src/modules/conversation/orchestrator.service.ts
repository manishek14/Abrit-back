import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { BotUpdate } from '../../database/entities/bot-update.entity';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { BotUpdateStage, MessageRole } from '../../database/enums';
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
 * Crash semantics (review fix #1 — RESUMABLE processing): every step is
 * idempotent and the completed milestones are recorded on bot_updates.stage.
 * On a crash the row stays PROCESSING and the sweeper requeues it; the re-run
 * then CONTINUES where the previous attempt stopped instead of dropping the
 * message:
 *   - addUserMessage returns the previously stored row for this update_id,
 *   - an already-stored assistant reply short-circuits the AI call,
 *   - the reply insert is protected by uq_messages_in_reply_to_assistant.
 * So "user message stored but never answered" can no longer happen.
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
      const error = e as Error;
      this.logger.error(
        `update ${update.update_id} failed processing: ${error.message} — will be retried by sweeper`,
      );
      // review fix #4-b: persist the failure reason on the row (status stays
      // PROCESSING on purpose — the sweeper still owns the retry policy)
      try {
        await this.inboxService.recordError(String(update.update_id), error.message);
      } catch (recordError) {
        this.logger.warn(`could not record error for update ${update.update_id}`);
      }
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
      // plan §6 rule 1: announce auto-created tickets durably. `created` is
      // true exactly once per ticket, so a crash-retry never duplicates it.
      await this.messagesService.addOutboundMessage({
        ticket_id: ticket.id,
        role: MessageRole.SYSTEM,
        content: `تیکت ${ticket.ticket_number} ایجاد شد.`,
      });
    }

    // addUserMessage RESUMES a crashed attempt: when this update already stored
    // its user message, the existing row is returned and processing continues
    // with the reply — the message is never left unanswered (review fix #1).
    const userMessage = await this.messagesService.addUserMessage({
      ticket_id: ticket.id,
      content: text,
      telegram_update_id: updateId,
    });
    await this.inboxService.setStage(updateId, BotUpdateStage.USER_SAVED);

    // Rare resume edge: the original attempt stored its message in a ticket
    // that has since been closed (admin action between crash and requeue) —
    // the reply must land in the SAME ticket as the user message it answers.
    const replyTicket =
      userMessage.ticket_id === ticket.id
        ? ticket
        : ((await this.ticketsService.findById(userMessage.ticket_id)) ?? ticket);

    // A previous attempt already stored the assistant reply → done, and no
    // second AI call (the expensive step) is made.
    const existingReply = await this.messagesService.findAssistantReply(userMessage.id);
    if (existingReply) {
      await this.inboxService.markDone(updateId);
      return;
    }

    const reply = await this.replyProvider.reply({ ticket: replyTicket, userMessage });
    try {
      await this.messagesService.addOutboundMessage({
        ticket_id: replyTicket.id,
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

    await this.inboxService.setStage(updateId, BotUpdateStage.REPLY_SAVED);
    await this.inboxService.markDone(updateId);
  }
}
