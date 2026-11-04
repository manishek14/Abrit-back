import { Ticket } from '../../database/entities/ticket.entity';
import { Message } from '../../database/entities/message.entity';

export interface ReplyResult {
  content: string;
  /** Provider metadata stored on the message (model, latency, fallback…) — never secrets. */
  meta?: Record<string, unknown> | null;
}

export interface ReplyProviderInput {
  ticket: Ticket;
  userMessage: Message;
}

/**
 * The single seam between the conversation pipeline and the assistant.
 * Phase 4 binds the real AI implementation (settings + context + OpenRouter);
 * tests bind fakes, so no test ever spends OpenRouter quota.
 */
export interface ReplyProvider {
  reply(input: ReplyProviderInput): Promise<ReplyResult>;
}

export const REPLY_PROVIDER = Symbol('REPLY_PROVIDER');
