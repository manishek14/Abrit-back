import { Inject, Injectable, Logger } from '@nestjs/common';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { UsersService } from '../users/users.service';
import { TicketsService } from '../tickets/tickets.service';
import { BotStateService } from './bot-state.service';
import { BotFlowState, ChatHistoryEntry } from './bot-state.types';
import { GeneralChatService } from '../ai/general-chat.service';
import { buildAbritContextBlock } from '../ai/abrit-persona';
import { TICKET_STATUS_LABELS } from '../../common/ticket-labels';
import {
  CHATBOT_ERROR,
  CHATBOT_INTRO,
  CHATBOT_LEFT,
  CHATBOT_WAITING,
  TELEGRAM_MESSAGE_MAX_CHARS,
} from '../../common/bot-messages';
import {
  BTN_CHATBOT_EXIT,
  chatbotKeyboard,
  mainMenuKeyboard,
} from '../telegram/keyboards';
import {
  sendEphemeral,
  TELEGRAM_GATEWAY,
  TelegramGateway,
} from '../telegram/telegram-gateway.interface';

/**
 * The CHATBOT MODE owner (request §4/§5) — the explicit, stateful way to talk
 * to ABRIT AI:
 *
 *   /chatbot (profile-gated) → intro + chatbot keyboard → CHAT state
 *   every later plain text is consumed HERE (never a ticket request, never a
 *   menu action — only real commands, parsed earlier by the router, escape);
 *   «🔙 بازگشت به منوی اصلی» clears the state and restores the main menu.
 *
 * runTurn is ALSO the router's default plain-text pipeline, so the waiting
 * message + editMessageText UX (§5) is ONE implementation, never duplicated.
 *
 * Per-update OpenRouter dedup (§5): the update id is marked BEFORE the
 * provider call — durably in the CHAT state, in a bounded in-process set for
 * the stateless default path — so a sweeper re-drive of the same update can
 * never call the paid provider twice.
 */
@Injectable()
export class ChatbotService {
  private readonly logger = new Logger('Chatbot');
  /** Bounded in-process dedup for the default (stateless) path. */
  private readonly recentTurns = new Map<string, number>();

  constructor(
    private readonly usersService: UsersService,
    private readonly ticketsService: TicketsService,
    private readonly botState: BotStateService,
    private readonly generalChat: GeneralChatService,
    @Inject(TELEGRAM_GATEWAY) private readonly gateway: TelegramGateway,
  ) {}

  /** /chatbot with a completed profile: (re)enters chat mode, keeps history. */
  async enter(user: TelegramUser, chatId: string): Promise<void> {
    const state = await this.botState.get(user);
    await this.botState.set(user.id, 'CHAT', {
      history: state?.flow === 'CHAT' ? (state.data?.history ?? []) : [],
    });
    await sendEphemeral(this.gateway, chatId, CHATBOT_INTRO, this.logger, {
      reply_markup: chatbotKeyboard(),
    });
  }

  /**
   * The CHAT state owner: returns false when the user is NOT chatting (the
   * router falls through), consumes EVERY text while they are — the exit
   * button leaves the mode, anything else is an AI question (§4: plain texts
   * in chat mode are never interpreted as commands or ticket requests).
   */
  async handleText(
    user: TelegramUser,
    chatId: string,
    text: string,
    updateId: string,
  ): Promise<boolean> {
    const state = await this.botState.get(user);
    if (!state || state.flow !== 'CHAT') return false;

    if (text === BTN_CHATBOT_EXIT) {
      await this.botState.clear(user.id);
      await sendEphemeral(this.gateway, chatId, CHATBOT_LEFT, this.logger, {
        reply_markup: mainMenuKeyboard(),
      });
      return true;
    }

    await this.runTurn(user, chatId, text, updateId, state);
    return true;
  }

  /**
   * ONE OpenRouter turn: dedup → waiting message → provider → history →
   * deliver (edit the waiting message in place, fall back to fresh sends,
   * split at the Telegram length limit).
   */
  async runTurn(
    user: TelegramUser,
    chatId: string,
    text: string,
    updateId: string,
    existingState?: BotFlowState | null,
  ): Promise<void> {
    const state = existingState ?? (await this.botState.get(user));
    const chatMode = state?.flow === 'CHAT';

    // §5 dedup — one update, one provider call. The CHAT marker is durable
    // (survives restarts); the in-process set covers the stateless path.
    if (chatMode && state?.data?.last_update_id === updateId) return;
    if (this.recentTurns.has(updateId)) return;
    this.rememberTurn(updateId);

    const history: ChatHistoryEntry[] = chatMode ? (state?.data?.history ?? []) : [];

    // mark BEFORE the call — a crash mid-call leaves the marker, so the
    // sweeper's re-drive skips instead of paying for the same request twice
    if (chatMode) {
      await this.botState.set(user.id, 'CHAT', { history, last_update_id: updateId });
    }

    // §5 step 2 — the waiting message MUST precede the OpenRouter wait
    const waiting = await this.sendWaitingMessage(chatId);

    let answer: string;
    let answeredByProvider = false;
    try {
      const activeTicket = await this.ticketsService.findActiveTicket(user.id);
      const contextBlock = buildAbritContextBlock({
        fullName: user.full_name,
        activeTicket: activeTicket
          ? `${activeTicket.ticket_number} (${TICKET_STATUS_LABELS[activeTicket.status]})`
          : null,
      });
      const result = await this.generalChat.reply({ history, contextBlock, userText: text });
      answeredByProvider = result.meta.provider === 'openrouter';

      if (answeredByProvider) {
        // history persists ONLY on a real AI answer — a fallback must not
        // poison the next turn with an unanswered question
        const next = this.botState.withChatTurn(state, text, result.content);
        await this.usersService.setBotState(user.id, next as TelegramUser['bot_state']);
        answer = result.content;
      } else {
        // §5: a provider failure/timeout reads as an UNDERSTANDABLE error the
        // user can simply retry — the ticket-style fallback text would lie
        // («پیام شما ثبت شد») inside a chat that stores nothing.
        this.logger.warn(`chatbot turn degraded (${String(result.meta.reason)}) — error reply`);
        answer = CHATBOT_ERROR;
      }
    } catch (e) {
      this.logger.error(`chatbot turn failed: ${(e as Error).message}`);
      answer = CHATBOT_ERROR;
    }

    await this.deliver(chatId, waiting, answer);
  }

  /** Fire-and-forget placeholder; null when the gateway is down — the turn
   *  still completes and the answer arrives as fresh messages. */
  private async sendWaitingMessage(
    chatId: string,
  ): Promise<string | null> {
    if (!this.gateway.active) return null;
    try {
      const sent = await this.gateway.sendMessage({ chat_id: chatId, text: CHATBOT_WAITING });
      return sent.message_id;
    } catch (e) {
      this.logger.warn(`waiting message failed (informational): ${(e as Error).message}`);
      return null;
    }
  }

  /** §5: edit the placeholder into the answer when possible, else fresh sends;
   *  answers beyond Telegram's 4096-char limit travel as several messages. */
  private async deliver(
    chatId: string,
    editingMessageId: string | null,
    content: string,
  ): Promise<void> {
    const chunks = splitForTelegram(content);
    if (editingMessageId && this.gateway.editMessageText) {
      try {
        await this.gateway.editMessageText({
          chat_id: chatId,
          message_id: editingMessageId,
          text: chunks[0],
        });
        for (const chunk of chunks.slice(1)) {
          await sendEphemeral(this.gateway, chatId, chunk, this.logger);
        }
        return;
      } catch (e) {
        this.logger.warn(`edit failed — falling back to a fresh send: ${(e as Error).message}`);
      }
    }
    for (const chunk of chunks) {
      await sendEphemeral(this.gateway, chatId, chunk, this.logger);
    }
  }

  private rememberTurn(updateId: string): void {
    if (this.recentTurns.size >= 1000) {
      const oldest = this.recentTurns.keys().next().value;
      if (oldest !== undefined) this.recentTurns.delete(oldest);
    }
    this.recentTurns.set(updateId, Date.now());
  }
}

/**
 * Telegram hard-caps one message at 4096 chars (§5: «پاسخ‌های طولانی باید
 * مطابق محدودیت طول پیام تلگرام مدیریت شوند»). Splits on the last newline /
 * space before the limit so words never break mid-token.
 */
export function splitForTelegram(text: string, limit = TELEGRAM_MESSAGE_MAX_CHARS): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
