import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BotUpdate } from '../../database/entities/bot-update.entity';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { Ticket } from '../../database/entities/ticket.entity';
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
 * Ordering guarantee (review fix — holds even after a failure): the
 * in-process per-chat promise chain serializes updates of the SAME chat, and
 * when a predecessor FAILS processing, every later update of that chat is
 * held at the DB-level ORDERING GATE (see InboxService.hasEarlierUnfinished)
 * until the predecessor reaches a terminal state — the second message's AI
 * context always contains the first message's reply, and the first reply can
 * never reach the user after the second one. Cross-chat updates run in
 * parallel. (Single-instance only — see docs/architecture.md.)
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
    const payload = update.payload as RawTelegramUpdate;
    const updateId = String(update.update_id);
    const msg = payload.message;

    // ── unsupported shapes: ignore permanently — these paths never produce
    // chat content, so they take no part in per-chat ordering.
    if (!msg || payload.edited_message) return void (await this.claimAndMarkDone(updateId));
    if (msg.chat?.type && msg.chat.type !== 'private') {
      return void (await this.claimAndMarkDone(updateId)); // groups/channels are out of scope (plan §6)
    }
    if (msg.from?.is_bot) return void (await this.claimAndMarkDone(updateId)); // never process bot senders

    const chatId = String(msg.chat.id);

    // ── ORDERING GATE (review fix — order after a failure) ────────────────
    // While an EARLIER update of THIS chat is still unfinished (not DONE and
    // not FAILED), this update must wait: processing it now could deliver its
    // reply BEFORE the earlier message's (retried) reply. Waiting is free —
    // the row stays RECEIVED (the claim's attempt counter is untouched) and
    // the sweeper re-drives it every pass until the blocker is terminal.
    if (await this.inboxService.hasEarlierUnfinished(chatId, updateId)) {
      this.logger.log(
        `update ${updateId} waits: an earlier update of chat ${chatId} is still unfinished`,
      );
      return;
    }

    const claimed = await this.inboxService.claim(update.update_id);
    if (!claimed) return; // another worker owns this update

    const claimedPayload = claimed.payload as RawTelegramUpdate;
    const message = claimedPayload.message;
    if (!message) {
      // Defensive: the pre-claim shape check already filtered this (the row is
      // the same) — but never leave a claimed row stuck in PROCESSING.
      await this.inboxService.markDone(updateId);
      return;
    }

    const user = await this.usersService.upsertTelegramUser({
      telegram_id: String(message.from?.id ?? message.chat.id),
      chat_id: String(message.chat.id),
      username: message.from?.username ?? null,
      first_name: message.from?.first_name ?? null,
      last_name: message.from?.last_name ?? null,
      language_code: message.from?.language_code ?? null,
    });

    if (user.is_blocked) {
      // BLOCKED-STATE RECOVERY (review fix): a fresh, valid update proves the
      // user has unblocked the bot (Telegram never delivers messages from a
      // chat that still blocks us — the 403 that set the flag cannot happen
      // again until they block once more). Instead of dropping their messages
      // forever, clear the stale flag and continue processing normally; a
      // still-blocked reality re-flags the user on the very next outbound 403.
      await this.usersService.setBlocked(user.id, false);
      user.is_blocked = false; // detached row — keep the in-memory view honest
      this.logger.log(
        `user ${user.telegram_id} was flagged blocked but sent a new message — flag cleared, processing resumes`,
      );
    }

    const text = (message.text ?? '').trim();

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
    // DEDUP-FIRST (review fix — no empty ticket after crash recovery): if a
    // previous attempt already stored this update's user message, it PINS the
    // update to that message's ORIGINAL ticket — checking BEFORE creating a
    // ticket means a retry (after an operator closed the original ticket in
    // the retry window) can never leave a fresh, EMPTY active ticket behind:
    // the reply lands in the ticket the user message actually lives in.
    let ticket: Ticket;
    const stored = await this.messagesService.findByTelegramUpdateId(updateId);
    if (stored) {
      const original = await this.ticketsService.findById(stored.ticket_id);
      if (!original) {
        throw new NotFoundException(
          `the stored user message for update ${updateId} references ticket ${stored.ticket_id} which no longer exists`,
        );
      }
      ticket = original;
    } else {
      const ensured = await this.ticketsService.ensureActiveTicket(user.id, text.slice(0, 60), {
        // the announcement is stored IN the ticket-creation transaction —
        // a crash can no longer split the two (review fix)
        announce: (ticketNumber) => `تیکت ${ticketNumber} ایجاد شد.`,
      });
      ticket = ensured.ticket;
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

    // Defensive: the resume row always belongs to `ticket` after dedup-first,
    // but keep the original-ticket lookup so a stored message can never pull
    // its reply into a different ticket.
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

  /** Shapes that are permanently ignored: claim (dedup vs other workers) then
   *  mark DONE — no ordering involvement, they never produce chat content. */
  private async claimAndMarkDone(updateId: string): Promise<void> {
    const claimed = await this.inboxService.claim(updateId);
    if (claimed) await this.inboxService.markDone(updateId);
  }
}
