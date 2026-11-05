import { BadRequestException } from '@nestjs/common';
import type { RawTelegramUpdate } from './types';

/** Telegram payloads are small; anything above this is not a real update. */
export const MAX_UPDATE_JSON_BYTES = 64 * 1024;

/** PostgreSQL bigint max (2^63-1) — update_id lives comfortably below it. */
const MAX_BIGINT = 9_223_372_036_854_775_807n;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Minimal STRUCTURAL validation of a raw Telegram update BEFORE it is persisted
 * to bot_updates (review fix #4-c): the webhook secret already authenticates
 * the sender; this keeps malformed/hostile JSON from being stored as "inbox
 * rows that can never be processed" and from producing confusing DB errors.
 *
 * Unknown-but-valid shapes (edited_message, channel_post, …) still pass —
 * the orchestrator is the one that decides to ignore them.
 */
export function isValidUpdateShape(update: unknown): update is RawTelegramUpdate {
  if (!isPlainObject(update)) return false;

  const updateId = update.update_id;
  if (typeof updateId !== 'number' || !Number.isInteger(updateId)) return false;
  if (updateId < 0 || BigInt(updateId) > MAX_BIGINT) return false;

  const message = update.message;
  if (message !== undefined) {
    if (!isPlainObject(message)) return false;
    if (typeof message.message_id !== 'number' || !Number.isInteger(message.message_id)) {
      return false;
    }
    const chat = message.chat;
    if (chat !== undefined && (!isPlainObject(chat) || !['number', 'string'].includes(typeof chat.id))) {
      return false;
    }
    const from = message.from;
    if (from !== undefined && !isPlainObject(from)) return false;
    if (message.text !== undefined && typeof message.text !== 'string') return false;
    if (message.date !== undefined && typeof message.date !== 'number') return false;
  }

  try {
    return Buffer.byteLength(JSON.stringify(update)) <= MAX_UPDATE_JSON_BYTES;
  } catch {
    return false;
  }
}

/** Throws a clean 400 instead of persisting garbage. */
export function assertValidUpdateShape(update: unknown): asserts update is RawTelegramUpdate {
  if (!isValidUpdateShape(update)) {
    throw new BadRequestException('Malformed Telegram update payload');
  }
}
