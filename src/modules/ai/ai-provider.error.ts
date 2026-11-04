export type AiErrorKind =
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'server'
  | 'auth'
  | 'credit'
  | 'model'
  | 'bad_request'
  | 'empty'
  | 'unknown';

/** Classified AI failure — retryable kinds are retried (≤ 2), the rest fall back immediately. */
export class AiProviderError extends Error {
  constructor(
    public readonly kind: AiErrorKind,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export function isAiProviderError(e: unknown): e is AiProviderError {
  return e instanceof AiProviderError;
}

/** HTTP status → typed error. Response bodies are safe to log (no secrets ever travel there). */
export function classifyHttpError(status: number, message: string, retryAfterMs?: number): AiProviderError {
  switch (status) {
    case 401:
      return new AiProviderError('auth', message, false, undefined, status);
    case 402:
      return new AiProviderError('credit', message, false, undefined, status);
    case 404:
      return new AiProviderError('model', message, false, undefined, status);
    case 400:
      return new AiProviderError('bad_request', message, false, undefined, status);
    case 429:
      return new AiProviderError('rate_limited', message, true, retryAfterMs, status);
    default:
      if (status >= 500) return new AiProviderError('server', message, true, retryAfterMs, status);
      return new AiProviderError('unknown', message, false, undefined, status);
  }
}
