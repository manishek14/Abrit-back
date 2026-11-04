/** Minimal structural typing of the Telegram update objects we persist as raw JSON. */
export interface RawTelegramUpdate {
  update_id: number | string;
  message?: RawTelegramMessage;
  edited_message?: unknown;
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
}
