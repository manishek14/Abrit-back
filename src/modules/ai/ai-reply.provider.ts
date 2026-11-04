import { Inject, Injectable, Logger } from '@nestjs/common';
import { getEnv } from '../../config/env';
import { AI_FALLBACK_MESSAGE, AI_INACTIVE_MESSAGE } from '../../common/ticket-labels';
import { SettingsService } from '../settings/settings.service';
import { ContextBuilderService } from './context-builder.service';
import { AI_PROVIDER, AiCompleteResult, AiProvider } from './ai-provider.interface';
import { AiProviderError, isAiProviderError } from './ai-provider.error';
import { Semaphore } from './semaphore';
import { ReplyProvider, ReplyResult } from './reply-provider.interface';
import { Ticket } from '../../database/entities/ticket.entity';
import { Message } from '../../database/entities/message.entity';

const MAX_AI_ATTEMPTS = 3; // 1 initial + 2 retries
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The ReplyProvider implementation bound in production. Policy:
 *  - assistant disabled in the panel      → fixed "recorded" reply,
 *  - OPENROUTER_API_KEY empty (today)      → fixed fallback reply, ZERO network calls,
 *  - otherwise → context (per-ticket) → OpenRouter with retry/backoff → on
 *    permanent failure/empty → honest fallback message. The user never gets a
 *    blank or contradictory answer, and their message is already stored.
 */
@Injectable()
export class AiReplyProvider implements ReplyProvider {
  private readonly logger = new Logger('AiReply');
  private readonly semaphore: Semaphore;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly contextBuilder: ContextBuilderService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {
    this.semaphore = new Semaphore(getEnv().AI_MAX_CONCURRENCY);
  }

  async reply(input: { ticket: Ticket; userMessage: Message }): Promise<ReplyResult> {
    const env = getEnv();
    const settings = await this.settingsService.get();

    if (!settings.is_active) {
      return {
        content: AI_INACTIVE_MESSAGE,
        meta: { provider: 'fixed', reason: 'assistant-disabled-by-admin' },
      };
    }

    if (!env.OPENROUTER_API_KEY) {
      // Per the project owner's instruction the key is intentionally empty for
      // now — no external call happens, the user still gets an honest reply.
      return {
        content: AI_FALLBACK_MESSAGE,
        meta: { provider: 'fixed', reason: 'api-key-not-configured' },
      };
    }

    const context = await this.contextBuilder.build(input.ticket.id, settings.system_prompt);

    for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
      const release = await this.semaphore.acquire();
      let result: AiCompleteResult | undefined;
      let failure: AiProviderError | undefined;

      try {
        result = await this.provider.complete({
          model: settings.model,
          messages: context.messages,
          maxTokens: env.AI_MAX_OUTPUT_TOKENS,
        });
      } catch (e) {
        failure = isAiProviderError(e)
          ? e
          : new AiProviderError('unknown', (e as Error).message, false);
      } finally {
        release();
      }

      const text = result?.text?.trim();
      if (result && text) {
        return {
          content: text,
          meta: {
            provider: 'openrouter',
            model: result.model,
            latencyMs: result.latencyMs,
            usage: result.usage,
            attempts: attempt,
            contextMessages: context.includedCount,
            contextTruncated: context.truncated,
          },
        };
      }
      if (result && !text) {
        failure = new AiProviderError('empty', 'model returned an empty response', false);
      }

      const retryable = failure?.retryable ?? false;
      if (retryable && attempt < MAX_AI_ATTEMPTS) {
        const delay = failure?.retryAfterMs ?? 500 * attempt * attempt;
        this.logger.warn(
          `AI attempt ${attempt}/${MAX_AI_ATTEMPTS} failed (${failure?.kind}) — retrying in ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }

      this.logger.error(
        `AI reply failed permanently (${failure?.kind ?? 'unknown'}): ${failure?.message ?? 'no response text'} — sending fallback to user`,
      );
      return {
        content: AI_FALLBACK_MESSAGE,
        meta: { provider: 'fixed', fallback: true, reason: failure?.kind ?? 'unknown', attempts: attempt },
      };
    }

    return {
      content: AI_FALLBACK_MESSAGE,
      meta: { provider: 'fixed', fallback: true, reason: 'retries-exhausted' },
    };
  }
}
