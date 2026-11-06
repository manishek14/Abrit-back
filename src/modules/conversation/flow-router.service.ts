import { Inject, Injectable, Logger, ConflictException } from '@nestjs/common';
import { BotUpdate } from '../../database/entities/bot-update.entity';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { MessageRole } from '../../database/enums';
import { UsersService } from '../users/users.service';
import { MessagesService } from '../messages/messages.service';
import { InboxService } from '../inbox/inbox.service';
import { ONLY_TEXT_SUPPORTED_MESSAGE } from '../../common/ticket-labels';
import { RegistrationService } from './registration.service';
import { TicketFlowService } from './ticket-flow.service';
import { MyTicketsService, StoredTicketReply } from './mytickets.service';
import { ChatbotService } from './chatbot.service';
import { CommandsService, parseCommand } from './commands.service';
import { sendEphemeral, TELEGRAM_GATEWAY, TelegramGateway } from '../telegram/telegram-gateway.interface';
import {
  BTN_CHATBOT_EXIT,
  BTN_COMPLETE_PROFILE,
  BTN_EDIT_PROFILE,
  BTN_HELP,
  BTN_MY_TICKETS,
  BTN_NEW_TICKET,
  BTN_PROFILE,
  BTN_TRACK,
  mainMenuKeyboard,
  profileGateKeyboard,
} from '../telegram/keyboards';
import { ReplyProvider, REPLY_PROVIDER } from '../ai/reply-provider.interface';
import { REG_REQUIRED } from '../../common/bot-messages';

/**
 * THE router: every claimed update is dispatched to EXACTLY ONE handler with
 * this strict precedence (request §8) —
 *
 *   1. callback_query          → my-tickets callbacks
 *   2. contact                 → registration (phone step)
 *   3. /commands               → commands (each one gates itself; /profile,
 *                                /help, /cancel, /chatbot stay reachable)
 *   4. registration state      → REGISTER_* texts (owned exclusively)
 *   5. ticket flow state       → TICKET_* texts + view/reply actions
 *                                (§4's hard rule: the wizard's description
 *                                NEVER reaches the AI/general handler)
 *   6. chatbot state           → CHAT mode texts (exit button or AI turn —
 *                                in chat mode plain texts are never menu
 *                                actions or ticket requests, §4/§7)
 *   7. profile gate            → protected-feature texts from a gated user
 *                                get the restriction + «تکمیل پروفایل»
 *                                keyboard; the button itself starts the flow
 *   8. main-menu buttons       → the matching action
 *   9. default plain text      → chatbot runTurn (waiting → OpenRouter →
 *                                edit-or-send) — never a ticket (§6)
 *
 * This replaces the old «every text = new ticket + AI reply» behaviour, which
 * was the original bug: a user mid-flow saw the generic greeting instead of
 * their flow's next step because no state existed at all.
 */
@Injectable()
export class FlowRouterService {
  private readonly logger = new Logger('FlowRouter');

  constructor(
    private readonly usersService: UsersService,
    private readonly messagesService: MessagesService,
    private readonly inboxService: InboxService,
    private readonly registration: RegistrationService,
    private readonly ticketFlow: TicketFlowService,
    private readonly myTickets: MyTicketsService,
    private readonly chatbot: ChatbotService,
    private readonly commandsService: CommandsService,
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
      // §2: an inline button is a protected feature — restriction + the
      // «تکمیل پروفایل»-only keyboard (never an auto-started registration).
      await this.gateway.answerCallbackQuery?.(cb.id);
      await sendEphemeral(this.gateway, chatId, REG_REQUIRED, this.logger, {
        reply_markup: profileGateKeyboard(),
      });
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

    // (2) the contact button only means something in the phone step
    if (msg.contact) {
      await this.registration.handleContact(user, chatId, msg.contact);
      await this.inboxService.markDone(updateId);
      return;
    }

    const text = (msg.text ?? '').trim();

    // (3) commands first — they must work in ANY state (/start, /cancel…)
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

    // (4)(5) §4 THE HARD RULE: a state owner consumes the text exclusively.
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

    // (6) chatbot mode owns EVERY plain text while active (§4: never a menu
    // action / ticket request in chat mode; only real commands escape)
    if (await this.chatbot.handleText(user, chatId, text, updateId)) {
      await this.inboxService.markDone(updateId);
      return;
    }

    // (7) profile gate (§2): protected-feature texts from a gated user get
    // the restriction + the «تکمیل پروفایل»-only keyboard; the button starts
    // the flow directly. Server-side, so no keyboard trick bypasses it.
    if (!this.registration.isComplete(user)) {
      // /profile and /help are NOT protected features (§1/§2) — the matching
      // menu buttons stay reachable for a gated user too.
      if (text === BTN_PROFILE || text === BTN_HELP) {
        await this.commandsService.handle(user, chatId, {
          name: text === BTN_HELP ? 'help' : 'profile',
          raw: text,
        });
      } else if (text === BTN_COMPLETE_PROFILE) {
        // §2: the gate keyboard's button enters the profile flow DIRECTLY —
        // no second restriction message in front of it.
        await this.registration.start(user, chatId);
      } else {
        await sendEphemeral(this.gateway, chatId, REG_REQUIRED, this.logger, {
          reply_markup: profileGateKeyboard(),
        });
      }
      await this.inboxService.markDone(updateId);
      return;
    }

    // the edit entry on the profile card re-runs registration (§2: /profile
    // stays usable for editing previous info)
    if (text === BTN_EDIT_PROFILE) {
      await this.registration.start(user, chatId);
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

    // (8) main-menu reply-keyboard buttons (exact factory constants — §5)
    if (await this.handleMenuButton(user, chatId, text)) {
      await this.inboxService.markDone(updateId);
      return;
    }

    // (9) default: OpenRouter general conversation (never a ticket — §6)
    await this.chatbot.runTurn(user, chatId, text, updateId);
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
      case BTN_CHATBOT_EXIT:
        // stale chatbot keyboard with a cleared state — return to the menu
        await sendEphemeral(this.gateway, chatId, 'منوی اصلی ربات:', this.logger, {
          reply_markup: mainMenuKeyboard(),
        });
        return true;
      default:
        return false;
    }
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
