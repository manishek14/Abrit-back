import { AiReplyProvider } from './ai-reply.provider';
import { ContextBuilderService } from './context-builder.service';
import { SettingsService } from '../settings/settings.service';
import { AiProvider, AiCompleteRequest } from './ai-provider.interface';
import { AiProviderError } from './ai-provider.error';
import { ReplyProviderInput } from './reply-provider.interface';
import { AssistantSetting } from '../../database/entities/assistant-setting.entity';
import { Ticket } from '../../database/entities/ticket.entity';
import { Message } from '../../database/entities/message.entity';
import { AI_FALLBACK_MESSAGE, AI_INACTIVE_MESSAGE } from '../../common/ticket-labels';
import { IntegrationStateService } from '../../common/integration-state/integration-state.service';
import { setTestEnv } from '../../common/testing/test-env';

setTestEnv({ OPENROUTER_API_KEY: 'sk-or-test' });

const mkSettings = (over: Partial<AssistantSetting> = {}): AssistantSetting =>
  ({
    id: 1,
    system_prompt: 'پرامپت تست',
    model: 'openrouter/auto',
    is_active: true,
    updated_by_admin_id: null,
    updated_at: new Date(),
    ...over,
  }) as AssistantSetting;

const mkInput = (): ReplyProviderInput =>
  ({
    ticket: { id: 't-1', ticket_number: 'TKT-10001' } as Ticket,
    userMessage: { id: 'm-9', ticket_id: 't-1' } as Message,
  }) as ReplyProviderInput;

describe('AiReplyProvider', () => {
  let settings: { get: jest.Mock };
  let context: { build: jest.Mock };
  let provider: { complete: jest.Mock };
  let service: AiReplyProvider;
  let integrationState: IntegrationStateService;

  const buildContext = {
    messages: [{ role: 'system' as const, content: 'پرامپت تست' }],
    includedCount: 2,
    truncated: false,
  };

  const makeService = () => {
    integrationState = new IntegrationStateService();
    service = new AiReplyProvider(
      settings as unknown as SettingsService,
      context as unknown as ContextBuilderService,
      provider as unknown as AiProvider,
      integrationState,
    );
  };

  beforeEach(() => {
    setTestEnv({ OPENROUTER_API_KEY: 'sk-or-test' });
    settings = { get: jest.fn().mockResolvedValue(mkSettings()) };
    context = { build: jest.fn().mockResolvedValue(buildContext) };
    provider = { complete: jest.fn() };
    makeService();
  });

  it('answers with the fixed message when the admin disabled the assistant (no call)', async () => {
    settings.get.mockResolvedValueOnce(mkSettings({ is_active: false }));

    const res = await service.reply(mkInput());

    expect(res.content).toBe(AI_INACTIVE_MESSAGE);
    expect(res.meta).toMatchObject({ provider: 'fixed', reason: 'assistant-disabled-by-admin' });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('reports openRouter as "starting" (not "disabled") while the key is configured but unproven', () => {
    // real-token smoke-test regression (2026-11-06): with a configured key the
    // status used to read 'disabled' until the first reply — readiness/panel
    // looked like the key was missing
    makeService();
    expect(integrationState.snapshot().openRouter.status).toBe('starting');
  });

  it('answers with the fallback message while the API key is empty (zero network calls)', async () => {
    setTestEnv({ OPENROUTER_API_KEY: '' });
    makeService();

    const res = await service.reply(mkInput());

    expect(res.content).toBe(AI_FALLBACK_MESSAGE);
    expect(res.meta).toMatchObject({ reason: 'api-key-not-configured' });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('returns the model answer with provider metadata', async () => {
    provider.complete.mockResolvedValueOnce({ text: 'پاسخ هوشمند مدل', model: 'openrouter/auto', latencyMs: 733, usage: { total_tokens: 99 } });

    const res = await service.reply(mkInput());

    expect(res.content).toBe('پاسخ هوشمند مدل');
    expect(res.meta).toMatchObject({
      provider: 'openrouter',
      model: 'openrouter/auto',
      attempts: 1,
      contextMessages: 2,
      usage: { total_tokens: 99 },
    });
    const req = provider.complete.mock.calls[0][0] as AiCompleteRequest;
    expect(req.messages[0]).toEqual({ role: 'system', content: 'پرامپت تست' });
    expect(req.maxTokens).toBe(500);
    // review round 6: a successful call proves the integration works
    expect(integrationState.snapshot().openRouter.status).toBe('ok');
  });

  it('retries retryable failures (429/server) and succeeds on the second attempt', async () => {
    provider.complete
      .mockRejectedValueOnce(new AiProviderError('rate_limited', 'too many requests', true, 1))
      .mockResolvedValueOnce({ text: 'پاسخ بعد از تلاش دوم', model: 'm', latencyMs: 5 });

    const res = await service.reply(mkInput());

    expect(res.content).toBe('پاسخ بعد از تلاش دوم');
    expect(res.meta).toMatchObject({ attempts: 2 });
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry permanent failures (401/402/404) and falls back honestly', async () => {
    provider.complete.mockRejectedValueOnce(
      new AiProviderError('auth', 'invalid key', false, undefined, 401),
    );

    const res = await service.reply(mkInput());

    expect(res.content).toBe(AI_FALLBACK_MESSAGE);
    expect(res.meta).toMatchObject({ fallback: true, reason: 'auth', attempts: 1 });
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('falls back on an empty model response (user never gets a blank reply)', async () => {
    provider.complete.mockResolvedValueOnce({ text: '   ', model: 'm', latencyMs: 5 });

    const res = await service.reply(mkInput());

    expect(res.content).toBe(AI_FALLBACK_MESSAGE);
    expect(res.meta).toMatchObject({ fallback: true, reason: 'empty' });
  });

  it('gives up after exhausting retries on persistent server errors', async () => {
    provider.complete.mockRejectedValue(new AiProviderError('server', 'OpenRouter 5xx', true, 1));

    const res = await service.reply(mkInput());

    expect(provider.complete).toHaveBeenCalledTimes(3);
    expect(res.content).toBe(AI_FALLBACK_MESSAGE);
    expect(res.meta).toMatchObject({ fallback: true, reason: 'server', attempts: 3 });
  });

  it('reports the OpenRouter lifecycle into the shared integration state (round 6)', async () => {
    // permanent failure → VISIBLE degradation, but never a thrown error
    provider.complete.mockRejectedValueOnce(
      new AiProviderError('auth', 'invalid key', false, undefined, 401),
    );
    await service.reply(mkInput());
    expect(integrationState.snapshot().openRouter).toMatchObject({
      status: 'degraded',
      detail: 'auth',
    });

    // no key at all → disabled (never degraded)
    setTestEnv({ OPENROUTER_API_KEY: '' });
    makeService();
    await service.reply(mkInput());
    expect(integrationState.snapshot().openRouter.status).toBe('disabled');
  });
});
