import { Inject, Injectable, Logger, ConflictException } from '@nestjs/common';
import { BotUpdate } from '../../database/entities/bot-update.entity';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { MessageRole } from '../../database/enums';
import { UsersService } from '../users/users.service';
import { TicketsService } from '../tickets/tickets.service';
import { MessagesService } from '../messages/messages.service';
import { InboxService } from '../inbox/inbox.service';
import { BotStateService, } from './bot-state.service';
import { ChatHistoryEntry } from './bot-state.types';
import { RegistrationService } from './registration.service';
import { TicketFlowService } from './ticket-flow.service';
import { MyTicketsService, StoredTicketReply } from './mytickets.service';
import { CommandsService, parseCommand } from './commands.service';
import { sendEphemeral, TELEGRAM_GATEWAY, TelegramGateway } from '../telegram/telegram-gateway.interface';
import {
  BTN_HELP,
  BTN_MY_TICKETS,
  BTN_NEW_TICKET,
  BTN_PROFILE,
  BTN_TRACK,
} from '../telegram/keyboards';
import { GeneralChatService } from '../ai/general-chat.service';
import { ReplyProvider, REPLY_PROVIDER } from '../ai/reply-provider.interface';
import { buildAbritContextBlock } from '../ai/abrit-persona';
import { TICKET_STATUS_LABELS, ONLY_TEXT_SUPPORTED_MESSAGE } from '../../common/ticket-labels';

/**
 * THE router (feature round §4 — the root-cause fix): every claimed update is
 * dispatched to EXACTLY ONE handler with this strict precedence —
 *
 *   callback_query → my-tickets callbacks
 *   contact        → registration (phone step)
 *   /command       → commands
 *   state flow     → the flow that owns the state (registration / wizard /
 *                    ticket view / ticket reply) — §4's hard rule: while the
 *                    wizard asks for the description, the text is consumed by
 *                    the wizard and NEVER reaches the general/AI handler
 *   menu button    → the matching main-menu action
 *   plain text     → OpenRouter general conversation (profile required)
 *
 * This replaces the old «every text = new ticket + AI reply» behaviour, which
 * was the bug: a user mid-flow saw the generic greeting instead of their
 * flow's next step because no state existed at all.
 */
@Injectable()
export class FlowRouterService {
  private readonly logger = new Logger('FlowRouter');

  constructor(
    private readonly usersService: UsersService,
    private readonly ticketsService: TicketsService,
    private readonly messagesService: MessagesService,
    private readonly inboxService: InboxService,
    private readonly botState: BotStateService,
    private readonly registration: RegistrationService,
    private readonly ticketFlow: TicketFlowService,
    private readonly myTickets: MyTicketsService,
    private readonly commandsService: CommandsService,
    private readonly generalChat: GeneralChatService,
    @Inject(REPLY_PROVIDER) private readonly replyProvider: ReplyProvider,
    @Inject(TELEGRAM_GATEWAY) private readonly gateway: TelegramGateway,
  ) {}

  async route(update: BotUpdate): Promise<void> {
    const updateId = String(update.update_id);
    const payload = update.payload as Record<string, any>;
    const cb = payload.callback_query;
    const msg = payload.message;

    if (cb) {
      await this.routeCallback(updateId, cb);
      return;
    }
    if (msg) {
      await this.routeMessage(updateId, msg);
      return;
    }
    // defensive: shape-unsupported content reached the router
    await this.inboxService.markDone(updateId);
  }

  // ── callback queries ────────────────────────────────────────────────────────

  private async routeCallback(updateId: string, cb: {
    id: string;
    from?: { id?: number | string; username?: string; first_name?: string; last_name?: string; language_code?: string };
    message?: { chat?: { id?: number | string } };
    data?: string;
  }): Promise<void> {
    const chatId = String(cb.message?.chat?.id ?? '');
    const user = await this.ensureUser(
      String(cb.from?.id ?? chatId),
      chatId,
      {
        username: cb.from?.username,
        first_name: cb.from?.first_name,
        last_name: cb.from?.last_name,
        language_code: cb.from?.language_code,
      },
    );
    if (!user) {
      await this.inboxService.markDone(updateId);
      return;
    }

    if (!this.registration.isComplete(user)) {
      await this.gateway.answerCallbackQuery?.(cb.id);
      await this.registration.start(user, chatId, { gated: true });
      await this.inboxService.markDone(updateId);
      return;
    }
    await this.myTickets.handleCallback(user, chatId, cb.id, cb.data ?? '');
    // NO try/catch here: a thrown error must propagate to the orchestrator so
    // the row stays PROCESSING and the sweeper retries it (never markDone on
    // failure — that would drop the update permanently).
    await this.inboxService.markDone(updateId);
  }

  // ── messages ────────────────────────────────────────────────────────────────

  private async routeMessage(updateId: string, msg: {
    chat?: { id?: number | string; type?: string };
    from?: { id?: number | string; is_bot?: boolean; username?: string; first_name?: string; last_name?: string; language_code?: string };
    text?: string;
    contact?: { phone_number?: string; user_id?: number | string };
  }): Promise<void> {
    const chatId = String(msg.chat?.id ?? '');
    const user = await this.ensureUser(
      String(msg.from?.id ?? chatId),
      chatId,
      msg.from ?? {},
    );
    if (!user) {
      await this.inboxService.markDone(updateId);
      return;
    }

      // §1: the contact button only means something in the phone step
      if (msg.contact) {
        await this.registration.handleContact(user, chatId, msg.contact);
        await this.inboxService.markDone(updateId);
        return;
      }

      const text = (msg.text ?? '').trim();

      // commands first — they must work in ANY state (/start, /cancel…)
      const command = parseCommand(text);
      if (command) {
        await this.commandsService.handle(user, chatId, command);
        await this.inboxService.markDone(updateId);
        return;
      }

      if (!text) {
        await sendEphemeral(this.gateway, chatId, ONLY_TEXT_SUPPORTED_MESSAGE, this.logger);
        await this.inboxService.markDone(updateId);
        return;
      }

      // §4 THE HARD RULE: a state owner consumes the text exclusively.
      if (await this.registration.handleText(user, chatId, text)) {
        await this.inboxService.markDone(updateId);
        return;
      }
      if (await this.ticketFlow.handleText(user, chatId, text, updateId)) {
        await this.inboxService.markDone(updateId);
        return;
      }
      const ticketReply = await this.myTickets.handleTicketReply(user, chatId, text, updateId);
      if (ticketReply) {
        await this.runTicketReplyPipeline(ticketReply);
        await this.inboxService.markDone(updateId);
        return;
      }
      if (await this.myTickets.handleViewAction(user, chatId, text)) {
        await this.inboxService.markDone(updateId);
        return;
      }

      // profile gate (§1/§8): main features stay locked until registration
      if (!this.registration.isComplete(user)) {
        await this.registration.start(user, chatId, { gated: true });
        await this.inboxService.markDone(updateId);
        return;
      }

      // DEDUP-FIRST (inherited from the old orchestrator): a re-run of an
      // update whose text was already stored (wizard finalize completed but
      // crashed before markDone) must NEVER fall through to general chat —
      // the work is done, the outbox owns the rest.
      const alreadyStored = await this.messagesService.findByTelegramUpdateId(updateId);
      if (alreadyStored) {
        await this.inboxService.markDone(updateId);
        return;
      }

      // main-menu reply-keyboard buttons (exact factory constants — §5)
      if (await this.handleMenuButton(user, chatId, text)) {
        await this.inboxService.markDone(updateId);
        return;
      }

    // default: OpenRouter general conversation (never a ticket — §6)
    await this.handleGeneralChat(user, chatId, text);
    await this.inboxService.markDone(updateId);
    // NO try/catch: a thrown error propagates to the orchestrator so the row
    // stays PROCESSING and the sweeper retries it — markDone above only ever
    // runs on the success paths (never on failure, never dropping an update).
  }

  private async ensureUser(
    telegramId: string,
    chatId: string,
    from: { username?: string; first_name?: string; last_name?: string; language_code?: string },
  ): Promise<TelegramUser | null> {
    if (!telegramId || telegramId === 'undefined') return null;
    const user = await this.usersService.upsertTelegramUser({
      telegram_id: telegramId,
      chat_id: chatId || telegramId,
      username: from.username ?? null,
      first_name: from.first_name ?? null,
      last_name: from.last_name ?? null,
      language_code: from.language_code ?? null,
    });
    if (user.is_blocked) {
      // BLOCKED-STATE RECOVERY (unchanged from the previous round): a fresh,
      // valid update proves the user has unblocked the bot.
      await this.usersService.setBlocked(user.id, false);
      user.is_blocked = false;
    }
    return user;
  }

  private async handleMenuButton(user: TelegramUser, chatId: string, text: string): Promise<boolean> {
    switch (text) {
      case BTN_NEW_TICKET:
        await this.ticketFlow.start(user, chatId);
        return true;
      case BTN_MY_TICKETS:
        await this.myTickets.show(user, chatId, 1);
        return true;
      case BTN_TRACK:
        await this.commandsService.handle(user, chatId, { name: 'status', raw: '/status' });
        return true;
      case BTN_PROFILE:
        await this.commandsService.handle(user, chatId, { name: 'profile', raw: '/profile' });
        return true;
      case BTN_HELP:
        await this.commandsService.handle(user, chatId, { name: 'help', raw: '/help' });
        return true;
      default:
        return false;
    }
  }

  /** General OpenRouter conversation — ephemeral, history kept in bot_state. */
  private async handleGeneralChat(
    user: TelegramUser,
    chatId: string,
    text: string,
  ): Promise<void> {
    const state = await this.botState.get(user);
    const history: ChatHistoryEntry[] =
      state?.flow === 'CHAT' ? (state.data?.history as ChatHistoryEntry[] | undefined) ?? [] : [];

    const activeTicket = await this.ticketsService.findActiveTicket(user.id);
    const contextBlock = buildAbritContextBlock({
      fullName: user.full_name,
      activeTicket: activeTicket
        ? `${activeTicket.ticket_number} (${TICKET_STATUS_LABELS[activeTicket.status]})`
        : null,
    });

    const result = await this.generalChat.reply({ history, contextBlock, userText: text });

    // history persists ONLY on a real AI answer — a fallback must not poison
    // the next turn with an unanswered question
    if (result.meta.provider === 'openrouter') {
      const next = this.botState.withChatTurn(state, text, result.content);
      await this.usersService.setBotState(user.id, next as TelegramUser['bot_state']);
    }

    await sendEphemeral(this.gateway, chatId, result.content, this.logger);
  }

  /** The durable in-ticket reply pipeline (stored → AI → outbox), with the
   *  exact resumability guarantees the old orchestrator had: an existing
   *  assistant reply short-circuits a retry (no second AI call, no resend). */
  private async runTicketReplyPipeline(reply: StoredTicketReply): Promise<void> {
    const existingReply = await this.messagesService.findAssistantReply(reply.userMessage.id);
    if (existingReply) return;

    const aiReply = await this.replyProvider.reply({
      ticket: reply.ticket,
      userMessage: reply.userMessage,
    });
    try {
      await this.messagesService.addOutboundMessage({
        ticket_id: reply.ticket.id,
        role: MessageRole.ASSISTANT,
        content: aiReply.content,
        in_reply_to_id: reply.userMessage.id,
        meta: aiReply.meta ?? null,
      });
    } catch (e) {
      if (e instanceof ConflictException) {
        // assistant already replied to this user message (retry after crash) — fine
      } else {
        throw e;
      }
    }
    // the state intentionally STAYS TICKET_REPLY — the user can keep messaging
  }
}
