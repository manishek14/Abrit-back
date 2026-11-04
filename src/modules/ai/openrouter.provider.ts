import { Logger } from '@nestjs/common';
import { Env } from '../../config/env';
import { AiCompleteRequest, AiCompleteResult, AiProvider } from './ai-provider.interface';
import { AiProviderError, classifyHttpError, isAiProviderError } from './ai-provider.error';

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Real OpenRouter integration — plain fetch, no SDK. The API key only lives in
 * the request Authorization header: it is never logged, stored or echoed in
 * errors. Timeouts use AbortController; errors are classified for the retry
 * policy in AiReplyProvider.
 */
export class OpenRouterProvider implements AiProvider {
  private readonly logger = new Logger('OpenRouter');

  constructor(private readonly env: Env) {}

  async complete(req: AiCompleteRequest): Promise<AiCompleteResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.env.OPENROUTER_TIMEOUT_MS);
    req.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const res = await fetch(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.env.OPENROUTER_API_KEY}`,
          'x-title': 'AbrIT Telegram Ticketing',
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          max_tokens: req.maxTokens,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        let message = `OpenRouter responded with status ${res.status}`;
        try {
          const parsed = JSON.parse(body) as { error?: { message?: unknown } };
          if (parsed?.error?.message) message = String(parsed.error.message);
        } catch {
          /* keep the default message */
        }
        const retryAfterRaw = res.headers.get('retry-after');
        const retryAfterMs = retryAfterRaw ? Number(retryAfterRaw) * 1000 : undefined;
        throw classifyHttpError(res.status, message, retryAfterMs);
      }

      const data = JSON.parse(await res.text()) as {
        model?: string;
        choices?: { message?: { content?: unknown } }[];
        usage?: Record<string, unknown>;
      };
      const content = data.choices?.[0]?.message?.content;

      return {
        text: typeof content === 'string' ? content : '',
        model: data.model ?? req.model,
        latencyMs: Date.now() - started,
        usage: data.usage,
      };
    } catch (e) {
      if (isAiProviderError(e)) throw e;
      if ((e as Error)?.name === 'AbortError') {
        throw new AiProviderError('timeout', 'OpenRouter request timed out', true);
      }
      this.logger.warn(`request failed before reaching OpenRouter: ${(e as Error).message}`);
      throw new AiProviderError('network', (e as Error).message, true);
    } finally {
      clearTimeout(timer);
    }
  }
}
