import { GeneralChatService } from './general-chat.service';
import { SettingsService } from '../settings/settings.service';
import { AiProvider } from './ai-provider.interface';
import { AiProviderError } from './ai-provider.error';
import { IntegrationStateService } from '../../common/integration-state/integration-state.service';
import { getEnv } from '../../config/env';
import { AI_FALLBACK_MESSAGE } from '../../common/ticket-labels';
import { ABRIT_AI_SYSTEM_PROMPT, buildAbritContextBlock } from './abrit-persona';

jest.mock('../../config/env', () => ({
  getEnv: jest.fn(),
}));

const envMock = getEnv as unknown as jest.Mock;

const baseEnv = () => ({
  OPENROUTER_API_KEY: 'sk-or-test',
  AI_MAX_CONCURRENCY: 2,
  AI_MAX_OUTPUT_TOKENS: 500,
});

const settings = (over: Record<string, unknown> = {}) =>
  ({ is_active: true, model: 'test-model', ...over }) as never;

describe('ABRIT persona prompt (feature §6)', () => {
  it('contains the required rules verbatim', () => {
    expect(ABRIT_AI_SYSTEM_PROMPT).toContain('دستیار هوشمند پشتیبانی ABRIT');
    expect(ABRIT_AI_SYSTEM_PROMPT).toContain('زبان پیش‌فرض پاسخ‌گویی فارسی است');
    expect(ABRIT_AI_SYSTEM_PROMPT).toContain('هیچ\u200cگاه شماره تیکت');
    expect(ABRIT_AI_SYSTEM_PROMPT).toContain('به ثبت تیکت راهنمایی کن');
    expect(ABRIT_AI_SYSTEM_PROMPT).toContain('نام دستیار: ABRIT AI');
  });

  it('context block carries ONLY backend-provided facts', () => {
    const block = buildAbritContextBlock({ fullName: 'علی رضایی', activeTicket: 'TKT-10001 (باز)' });
    expect(block).toContain('علی رضایی');
    expect(block).toContain('TKT-10001');
    const none = buildAbritContextBlock({ fullName: null, activeTicket: null });
    expect(none).toContain('تیکت فعالی ندارد');
  });
});

describe('GeneralChatService (feature §6 — مکالمات عمومی با OpenRouter)', () => {
  let service: GeneralChatService;
  let settingsService: { get: jest.Mock };
  let provider: { complete: jest.Mock };
  let integrationState: { setOpenRouter: jest.Mock };

  beforeEach(() => {
    envMock.mockReturnValue(baseEnv());
    settingsService = { get: jest.fn().mockResolvedValue(settings()) };
    provider = {
      complete: jest.fn().mockResolvedValue({
        text: 'سلام! چطور می‌توانم کمکتان کنم؟',
        model: 'test-model',
        latencyMs: 120,
        usage: { total_tokens: 42 },
      }),
    };
    integrationState = { setOpenRouter: jest.fn() };
    service = new GeneralChatService(
      settingsService as unknown as SettingsService,
      provider as unknown as AiProvider,
      integrationState as unknown as IntegrationStateService,
    );
  });

  it('success → returns the model reply with usage meta and reports ok', async () => {
    const out = await service.reply({ history: [], contextBlock: 'CTX', userText: 'سلام' });
    expect(out.content).toContain('سلام');
    expect(out.meta.provider).toBe('openrouter');
    expect(out.meta.usage).toEqual({ total_tokens: 42 });
    expect(integrationState.setOpenRouter).toHaveBeenCalledWith('ok');
  });

  it('sends the persona system prompt + context block + history + user text', async () => {
    await service.reply({
      history: [
        { r: 'u', c: 'q1' },
        { r: 'a', c: 'a1' },
      ],
      contextBlock: 'CTX',
      userText: 'سؤال جدید',
    });
    const req = provider.complete.mock.calls[0][0];
    expect(req.messages).toHaveLength(4);
    expect(req.messages[0].role).toBe('system');
    expect(req.messages[0].content).toContain('دستیار هوشمند پشتیبانی ABRIT');
    expect(req.messages[0].content).toContain('CTX');
    expect(req.messages.at(-1)).toEqual({ role: 'user', content: 'سؤال جدید' });
  });

  it('NO API key → honest fallback, ZERO network calls, state disabled (§8)', async () => {
    envMock.mockReturnValue({ ...baseEnv(), OPENROUTER_API_KEY: '' });
    const out = await service.reply({ history: [], contextBlock: '', userText: 'سلام' });
    expect(out.content).toBe(AI_FALLBACK_MESSAGE);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(integrationState.setOpenRouter).toHaveBeenCalledWith('disabled');
  });

  it('assistant disabled from the panel → fallback without provider calls', async () => {
    settingsService.get.mockResolvedValue(settings({ is_active: false }));
    const out = await service.reply({ history: [], contextBlock: '', userText: 'سلام' });
    expect(out.content).toBe(AI_FALLBACK_MESSAGE);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('OpenRouter outage → fallback reply, degraded state, main flows unaffected (§8.13)', async () => {
    // a REAL outage is retryable (OpenRouterProvider classifies network/timeout)
    provider.complete.mockRejectedValue(
      new AiProviderError('network', 'network down', true),
    );
    const out = await service.reply({ history: [], contextBlock: '', userText: 'سلام' });
    expect(out.content).toBe(AI_FALLBACK_MESSAGE);
    expect(out.meta.fallback).toBe(true);
    expect(integrationState.setOpenRouter).toHaveBeenCalledWith('degraded', 'network');
    expect(provider.complete).toHaveBeenCalledTimes(2); // bounded attempts
  });

  it('a NON-retryable failure answers the fallback after ONE attempt (no budget burn)', async () => {
    provider.complete.mockRejectedValue(new AiProviderError('auth', 'bad key', false));
    const out = await service.reply({ history: [], contextBlock: '', userText: 'سلام' });
    expect(out.content).toBe(AI_FALLBACK_MESSAGE);
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });
});
