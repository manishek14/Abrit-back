import { TicketDepartment } from '../../database/enums';

/**
 * The conversation state machine (feature round: mandatory profile + staged
 * ticket wizard). Persisted on telegram_users.bot_state (jsonb) so a restart
 * or a sweeper requeue never drops the user's position, and every update is
 * routed to EXACTLY ONE handler — the root-cause fix for the old bug where a
 * plain text could fall through to the general/AI handler mid-wizard.
 */
export const BOT_FLOWS = [
  'REGISTER_NAME',
  'REGISTER_PHONE',
  'TICKET_TITLE',
  'TICKET_DEPARTMENT',
  'TICKET_DESCRIPTION',
  'TICKET_RETRY',
  'TICKET_VIEW',
  'TICKET_REPLY',
  'CHAT',
] as const;

export type BotFlow = (typeof BOT_FLOWS)[number];

export interface ChatHistoryEntry {
  /** 'u' = user, 'a' = assistant (compact keys keep the jsonb small). */
  r: 'u' | 'a';
  c: string;
}

/** Everything a flow may carry between steps. */
export interface BotStateData {
  /** registration step 1 → 2 */
  name?: string;
  /** wizard inputs */
  title?: string;
  department?: TicketDepartment;
  description?: string;
  /** ticket view / reply context */
  ticketId?: string;
  /** general-chat history (compact entries) */
  history?: ChatHistoryEntry[];
  /**
   * Chatbot dedup marker (request §5: «از ارسال درخواست تکراری به OpenRouter
   * برای یک Update جلوگیری کن»): the update currently being (or already)
   * answered. A sweeper re-drive of the SAME update sees its own marker and
   * skips the second provider call — at-most-once per update, chosen
   * deliberately over at-least-once for paid AI calls.
   */
  last_update_id?: string;
}

export type StateInput = BotStateData;

export interface BotFlowState {
  flow: BotFlow;
  data?: BotStateData;
  updated_at: string;
}

export function isBotFlow(value: unknown): value is BotFlow {
  return typeof value === 'string' && (BOT_FLOWS as readonly string[]).includes(value);
}

/** Strict parse of the raw jsonb column — a corrupt/foreign shape reads as "no state". */
export function parseBotState(raw: unknown): BotFlowState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as { flow?: unknown; data?: unknown; updated_at?: unknown };
  if (!isBotFlow(candidate.flow)) return null;
  const data =
    candidate.data && typeof candidate.data === 'object' && !Array.isArray(candidate.data)
      ? (candidate.data as BotStateData)
      : undefined;
  return {
    flow: candidate.flow,
    data,
    updated_at:
      typeof candidate.updated_at === 'string' ? candidate.updated_at : new Date(0).toISOString(),
  };
}

/** Chat-history cap: 8 turns × ~700 chars keeps the jsonb column small. */
export const CHAT_HISTORY_MAX_ENTRIES = 8;
export const CHAT_HISTORY_MAX_ENTRY_CHARS = 700;
