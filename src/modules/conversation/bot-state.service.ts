import { Injectable } from '@nestjs/common';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { UsersService } from '../users/users.service';
import {
  BotFlow,
  BotFlowState,
  BotStateData,
  CHAT_HISTORY_MAX_ENTRIES,
  ChatHistoryEntry,
  parseBotState,
} from './bot-state.types';

/**
 * HOW LONG a stored flow may sit untouched before it is auto-expired (§8:
 * «جلوگیری از باقی ماندن State قدیمی و ناسازگار»). Three hours: long enough
 * for a distracted user to finish the wizard, short enough that yesterday's
 * half-filled form can never hijack today's messages.
 */
export const BOT_STATE_TTL_MS = 3 * 60 * 60 * 1000;

/**
 * Per-user conversation state, persisted on telegram_users.bot_state (DB —
 * survives restarts and sweeper requeues) and read/written ONLY inside the
 * per-chat serialized pipeline, which makes plain read/modify/write safe
 * without locks.
 *
 * The router treats an expired or missing state EXACTLY like "no state":
 * the user falls through to the default routing (menu buttons → general
 * chat), never into a stale wizard.
 */
@Injectable()
export class BotStateService {
  constructor(private readonly usersService: UsersService) {}

  /**
   * The user's live state — null when absent OR expired (expired clears the row).
   *
   * ALWAYS re-reads the row from the database instead of trusting the passed
   * entity: the orchestrator's `user` object was loaded at the START of the
   * update, and a flow that does set() → get() WITHIN one update (the wizard's
   * description → finalize) must see its own write, never the stale snapshot.
   */
  async get(user: TelegramUser, ttlMs = BOT_STATE_TTL_MS): Promise<BotFlowState | null> {
    const row = await this.usersService.findByIdOrNull(user.id);
    const state = parseBotState(row?.bot_state);
    if (!state) return null;
    if (Date.now() - Date.parse(state.updated_at) > ttlMs) {
      await this.clear(user.id);
      return null;
    }
    return state;
  }

  async set(userId: string, flow: BotFlow, data: BotStateData = {}): Promise<void> {
    const state: BotFlowState = { flow, data, updated_at: new Date().toISOString() };
    await this.usersService.setBotState(userId, state as unknown as TelegramUser['bot_state']);
  }

  async clear(userId: string): Promise<void> {
    await this.usersService.setBotState(userId, null);
  }

  /** Appends one turn to the general-chat history (capped, oldest dropped). */
  withChatTurn(
    state: BotFlowState | null,
    userText: string,
    assistantText: string,
  ): { flow: BotFlow; data: BotStateData } {
    const history: ChatHistoryEntry[] = [
      ...(state?.flow === 'CHAT' ? (state.data?.history ?? []) : []),
      { r: 'u' as const, c: clip(userText) },
      { r: 'a' as const, c: clip(assistantText) },
    ].slice(-CHAT_HISTORY_MAX_ENTRIES);
    return { flow: 'CHAT', data: { history } };
  }
}

function clip(text: string): string {
  const t = text.trim().slice(0, 700);
  return t.length === 0 ? '…' : t;
}
