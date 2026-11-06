/** Minimal structural typing of the Telegram update objects we persist as raw JSON. */

export interface RawTelegramUpdate {
  update_id: number | string;
  message?: RawTelegramMessage;
  edited_message?: unknown;
  callback_query?: RawCallbackQuery;
  [k: string]: unknown;
}

export interface RawTelegramMessage {
  message_id: number;
  from?: {
    id: number | string;
    is_bot?: boolean;
    username?: string;
    first_name?: string;
    last_name?: string;
    language_code?: string;
  };
  chat: { id: number | string; type: string };
  date?: number;
  text?: string;
  /** Sent by the registration keyboard's request_contact button (§1). */
  contact?: {
    phone_number?: string;
    first_name?: string;
    /** Telegram only sets this when the contact belongs to the sender. */
    user_id?: number | string;
  };
}

/**
 * Inline-keyboard presses (my-tickets pagination / ticket selection). The
 * embedded `message` carries the chat the button lives in — the per-chat
 * ordering key and the reply target.
 */
export interface RawCallbackQuery {
  id: string;
  from: {
    id: number | string;
    is_bot?: boolean;
    username?: string;
    first_name?: string;
    last_name?: string;
    language_code?: string;
  };
  message?: { message_id: number; chat: { id: number | string; type: string } };
  /** ≤ 64 bytes by Telegram's contract; our data is `myt:view:<uuid>` / `myt:page:<n>`. */
  data?: string;
}
