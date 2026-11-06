import { IntegrationStateService } from './integration-state.service';

/**
 * Review round 6 fix #1 — the integration runtime state that the readiness
 * probe reflects. A configured-but-broken integration must be visible as
 * `degraded`, never disguised as healthy.
 */
describe('IntegrationStateService', () => {
  let service: IntegrationStateService;

  beforeEach(() => {
    service = new IntegrationStateService();
  });

  it('starts as disabled on both integrations', () => {
    expect(service.snapshot()).toEqual({
      telegram: { status: 'disabled', detail: '', since: expect.any(String) },
      openRouter: { status: 'disabled', detail: '', since: expect.any(String) },
    });
  });

  it('records a degraded Telegram bootstrap with the failure reason', () => {
    service.setTelegram('degraded', '401: Unauthorized');

    const snap = service.snapshot();
    expect(snap.telegram.status).toBe('degraded');
    expect(snap.telegram.detail).toBe('401: Unauthorized');
    expect(snap.openRouter.status).toBe('disabled'); // untouched
  });

  it('tracks status transitions with fresh timestamps', async () => {
    service.setTelegram('starting');
    const sinceStart = service.snapshot().telegram.since;
    await new Promise((r) => setTimeout(r, 5));
    service.setTelegram('ok');

    const telegram = service.snapshot().telegram;
    expect(telegram.status).toBe('ok');
    expect(telegram.detail).toBe('');
    expect(new Date(telegram.since).getTime()).toBeGreaterThanOrEqual(new Date(sinceStart).getTime());
  });

  it('records OpenRouter degradation without touching Telegram', () => {
    service.setTelegram('ok');
    service.setOpenRouter('degraded', 'rate-limited');

    const snap = service.snapshot();
    expect(snap.openRouter.status).toBe('degraded');
    expect(snap.openRouter.detail).toBe('rate-limited');
    expect(snap.telegram.status).toBe('ok');
  });

  it('returns a copy — mutating the snapshot never corrupts the source', () => {
    service.setTelegram('ok');
    const snap = service.snapshot();
    snap.telegram.status = 'degraded';

    expect(service.snapshot().telegram.status).toBe('ok');
  });
});
