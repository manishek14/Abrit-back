import { Injectable } from '@nestjs/common';
import { AI_FALLBACK_MESSAGE } from '../../common/ticket-labels';
import { ReplyProvider, ReplyResult } from './reply-provider.interface';

/**
 * Phase-3 placeholder bound while OPENROUTER_API_KEY is empty: every user
 * message gets the fixed fallback reply (plan §6 rule 3). Phase 4 replaces this
 * binding with the real OpenRouter-backed provider — no other file changes.
 */
@Injectable()
export class FixedReplyProvider implements ReplyProvider {
  async reply(): Promise<ReplyResult> {
    return {
      content: AI_FALLBACK_MESSAGE,
      meta: { provider: 'fixed-fallback', reason: 'OpenRouter key not configured yet' },
    };
  }
}
