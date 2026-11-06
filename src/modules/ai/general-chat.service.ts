import { Inject, Injectable, Logger } from '@nestjs/common';
import { getEnv } from '../../config/env';
import { AI_FALLBACK_MESSAGE } from '../../common/ticket-labels';
import { IntegrationStateService } from '../../common/integration-state/integration-state.service';
import { SettingsService } from '../settings/settings.service';
import { AI_PROVIDER, AiCompleteResult, AiProvider } from './ai-provider.interface';
import { AiProviderError, isAiProviderError } from './ai-provider.error';
import { Semaphore } from './semaphore';
import { ABRIT_AI_SYSTEM_PROMPT } from './abrit-persona';
import { ChatHistoryEntry } from '../conversation/bot-state.types';

const MAX_ATTEMPTS = 2; // general chat is ephemeral — fail fast, answer fallback

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface GeneralChatResult {
  content: string;
  meta: {
    provider: 'openrouter' | 'fixed';
    model?: string;
    latencyMs?: number;
    usage?: Record<string, unknown>;
    attempts?: number;
    fallback?: boolean;
    reason?: string;
  };
}

/**
 * OpenRouter conversations OUTSIDE any ticket (feature requirement §6):
 * general questions, bot usage guidance, intent triage — powered by the exact
 * ABRIT AI persona prompt + real backend facts (profile name, active ticket).
 *
 * Deliberately REUSES the production seams (no second client, no parallel
 * wiring — §10): the same AI_PROVIDER transport, the same semaphore bound, the
 * same integration-state reporting and the same fallback philosophy as
 * AiReplyProvider. The differences are policy, not plumbing: no ticket row is
 * written (ephemeral send), so an outage here can never disturb ticket flows.
 */
@Injectable()
export class GeneralChatService {
  private readonly logger = new Logger('GeneralChat');
  private readonly semaphore: Semaphore;

  constructor(
    private readonly settingsService: SettingsService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly integrationState: IntegrationStateService,
  ) {
    this.semaphore = new Semaphore(getEnv().AI_MAX_CONCURRENCY);
  }

  async reply(input: {
    history: ChatHistoryEntry[];
    contextBlock: string;
    userText: string;
  }): Promise<GeneralChatResult> {
    const env = getEnv();
    const settings = await this.settingsService.get();

    if (!env.OPENROUTER_API_KEY) {
      this.integrationState.setOpenRouter('disabled');
      return {
        content: AI_FALLBACK_MESSAGE,
        meta: { provider: 'fixed', fallback: true, reason: 'api-key-not-configured' },
      };
    }
    if (!settings.is_active) {
      return {
        content: AI_FALLBACK_MESSAGE,
        meta: { provider: 'fixed', fallback: true, reason: 'assistant-disabled-by-admin' },
      };
    }

    const messages = [
      { role: 'system' as const, content: `${ABRIT_AI_SYSTEM_PROMPT}\n\n${input.contextBlock}` },
      ...input.history.slice(-8).map((h) => ({
        role: h.r === 'u' ? ('user' as const) : ('assistant' as const),
        content: h.c,
      })),
      { role: 'user' as const, content: input.userText },
    ];

    let lastFailure: AiProviderError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const release = await this.semaphore.acquire();
      let result: AiCompleteResult | undefined;
      let failure: AiProviderError | undefined;
      try {
        result = await this.provider.complete({
          model: settings.model,
          messages,
          maxTokens: env.AI_MAX_OUTPUT_TOKENS,
        });
      } catch (e) {
        failure = isAiProviderError(e)
          ? e
          : new AiProviderError('unknown', (e as Error).message, false);
      } finally {
        release();
      }
      if (failure) lastFailure = failure;

      const text = result?.text?.trim();
      if (result && text) {
        this.integrationState.setOpenRouter('ok');
        return {
          content: text,
          meta: {
            provider: 'openrouter',
            model: result.model,
            latencyMs: result.latencyMs,
            usage: result.usage,
            attempts: attempt,
          },
        };
      }

      if (attempt < MAX_ATTEMPTS && (failure?.retryable || (result && !text))) {
        await sleep(400 * attempt);
        continue;
      }
      break;
    }

    // §8: an OpenRouter outage must never disturb the bot's main flows —
    // the general chat degrades to an honest fallback, everything else works.
    this.integrationState.setOpenRouter('degraded', lastFailure?.kind ?? 'unknown');
    this.logger.warn(`general chat failed (${lastFailure?.kind ?? 'empty'}) — fallback reply`);
    return {
      content: AI_FALLBACK_MESSAGE,
      meta: {
        provider: 'fixed',
        fallback: true,
        reason: lastFailure?.kind ?? 'empty',
        attempts: MAX_ATTEMPTS,
      },
    };
  }
}
