import { OpenRouterProvider } from './openrouter.provider';
import { AiProviderError, isAiProviderError } from './ai-provider.error';
import { setTestEnv } from '../../common/testing/test-env';

setTestEnv({ OPENROUTER_API_KEY: 'sk-or-test', OPENROUTER_TIMEOUT_MS: '300' });

const mkRes = (status: number, body: unknown, headers: Record<string, string | null> = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as unknown as Response;

describe('OpenRouterProvider', () => {
  const provider = new OpenRouterProvider({
    OPENROUTER_API_KEY: 'sk-or-test',
    OPENROUTER_TIMEOUT_MS: 300,
  } as never);

  const originalFetch = globalThis.fetch;

  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = originalFetch;
  });

  it('parses a successful completion', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () =>
      mkRes(200, {
        model: 'openrouter/auto',
        choices: [{ message: { content: 'سلام در خدمتم' } }],
        usage: { total_tokens: 42 },
      }),
    );

    const res = await provider.complete({ model: 'openrouter/auto', messages: [], maxTokens: 500 });

    expect(res.text).toBe('سلام در خدمتم');
    expect(res.model).toBe('openrouter/auto');
    expect(res.usage).toEqual({ total_tokens: 42 });
  });

  it('classifies 401 as a permanent auth error (message from body, never the key)', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () =>
      mkRes(401, { error: { message: 'Invalid API key provided' } }),
    );

    await expect(provider.complete({ model: 'm', messages: [], maxTokens: 10 })).rejects.toThrow(
      AiProviderError,
    );
    try {
      await provider.complete({ model: 'm', messages: [], maxTokens: 10 });
    } catch (e) {
      expect(isAiProviderError(e)).toBe(true);
      expect((e as AiProviderError).kind).toBe('auth');
      expect((e as AiProviderError).retryable).toBe(false);
      expect((e as Error).message).toContain('Invalid API key');
      expect((e as Error).message).not.toContain('sk-or-test');
    }
  });

  it('classifies 429 as retryable and honors the Retry-After header', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () =>
      mkRes(429, { error: { message: 'rate limited' } }, { 'retry-after': '3' }),
    );

    await expect(provider.complete({ model: 'm', messages: [], maxTokens: 10 })).rejects.toThrow(
      AiProviderError,
    );
    try {
      await provider.complete({ model: 'm', messages: [], maxTokens: 10 });
    } catch (e) {
      expect((e as AiProviderError).kind).toBe('rate_limited');
      expect((e as AiProviderError).retryAfterMs).toBe(3000);
    }
  });

  it('classifies 5xx as a retryable server error', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => mkRes(503, 'unavailable'));

    try {
      await provider.complete({ model: 'm', messages: [], maxTokens: 10 });
    } catch (e) {
      expect((e as AiProviderError).kind).toBe('server');
      expect((e as AiProviderError).retryable).toBe(true);
    }
  });

  it('classifies network failures as retryable', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });

    try {
      await provider.complete({ model: 'm', messages: [], maxTokens: 10 });
    } catch (e) {
      expect(isAiProviderError(e)).toBe(true);
      expect((e as AiProviderError).kind).toBe('network');
      expect((e as AiProviderError).retryable).toBe(true);
    }
  });

  it('aborts into a timeout error when the model is too slow', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(
      (_url: unknown, opts: RequestInit & { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );

    try {
      await provider.complete({ model: 'm', messages: [], maxTokens: 10 });
    } catch (e) {
      expect((e as AiProviderError).kind).toBe('timeout');
      expect((e as AiProviderError).retryable).toBe(true);
    }
  });
});
