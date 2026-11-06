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
    // chat is REQUIRED whenever a message exists (review round 5 fix #3): the
    // orchestrator reads message.chat.id unconditionally (chat key, user
    // upsert, per-chat ordering), so a "message" without a valid chat used to
    // pass validation, enter the inbox, fail processing and burn sweeper
    // retries — it must be a clean 400 instead, BEFORE the row is stored.
    const chat = message.chat;
    if (!isPlainObject(chat) || !['number', 'string'].includes(typeof chat.id)) {
      return false;
    }
    if (typeof chat.type !== 'string') return false;
    const from = message.from;
    if (from !== undefined && !isPlainObject(from)) return false;
    if (message.text !== undefined && typeof message.text !== 'string') return false;
    if (message.date !== undefined && typeof message.date !== 'number') return false;
    // contact (registration step 2): structurally checked when present
    if (message.contact !== undefined) {
      if (!isPlainObject(message.contact)) return false;
      if (
        message.contact.phone_number !== undefined &&
        typeof message.contact.phone_number !== 'string'
      ) {
        return false;
      }
      if (
        message.contact.user_id !== undefined &&
        !['number', 'string'].includes(typeof message.contact.user_id)
      ) {
        return false;
      }
    }
  }

  // callback_query (inline keyboards — my-tickets): the orchestrator reads
  // id/from/message.chat unconditionally, so the same "shape before storage"
  // rule applies to it as to messages.
  const cb = update.callback_query;
  if (cb !== undefined) {
    if (!isPlainObject(cb)) return false;
    if (typeof cb.id !== 'string' || cb.id.length === 0 || cb.id.length > 128) return false;
    if (!isPlainObject(cb.from)) return false;
    if (!['number', 'string'].includes(typeof cb.from.id)) return false;
    if (cb.message !== undefined) {
      if (!isPlainObject(cb.message)) return false;
      const chat = cb.message.chat;
      if (!isPlainObject(chat) || !['number', 'string'].includes(typeof chat.id)) return false;
      if (typeof chat.type !== 'string') return false;
      if (
        cb.message.message_id !== undefined &&
        (typeof cb.message.message_id !== 'number' || !Number.isInteger(cb.message.message_id))
      ) {
        return false;
      }
    }
    if (cb.data !== undefined && typeof cb.data !== 'string') return false;
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
