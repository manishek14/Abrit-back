import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HealthController } from './health.controller';
import { IntegrationStateService } from '../../common/integration-state/integration-state.service';

/**
 * Review round 6 fix #1 — Liveness vs Readiness split:
 *  - liveness never consults external dependencies,
 *  - readiness requires the DB AND a working (or disabled) Telegram transport,
 *  - a degraded OpenRouter is REPORTED but never takes the API down.
 */
describe('HealthController (liveness & readiness)', () => {
  let dataSource: { query: jest.Mock };
  let state: IntegrationStateService;
  let controller: HealthController;

  beforeEach(() => {
    dataSource = { query: jest.fn().mockResolvedValue([]) };
    state = new IntegrationStateService();
    controller = new HealthController(
      dataSource as unknown as DataSource,
      state,
    );
  });

  describe('liveness', () => {
    it('always reports ok — even with every integration broken and the DB down', () => {
      dataSource.query.mockRejectedValueOnce(new Error('db gone'));
      state.setTelegram('degraded', '401: Unauthorized');
      state.setOpenRouter('degraded', 'timeout');

      expect(controller.live()).toMatchObject({ status: 'ok' });
    });
  });

  describe('readiness', () => {
    it('is ok when the DB is up and no integration is configured', async () => {
      await expect(controller.ready()).resolves.toMatchObject({
        status: 'ok',
        db: 'up',
        integrations: {
          telegram: { status: 'disabled' },
          openRouter: { status: 'disabled' },
        },
      });
    });

    it('is 503 when the database is down (integration state still included)', async () => {
      state.setTelegram('ok');
      dataSource.query.mockRejectedValueOnce(new Error('connection refused'));

      await expect(controller.ready()).rejects.toThrow(ServiceUnavailableException);
      try {
        await controller.ready();
      } catch (e) {
        expect((e as ServiceUnavailableException).getResponse()).toMatchObject({
          status: 'error',
          db: 'down',
          integrations: { telegram: { status: 'ok' } },
        });
      }
    });

    it('is 503 when Telegram is configured but DEGRADED (the bot is dead)', async () => {
      dataSource.query.mockResolvedValue([]); // db fine
      state.setTelegram('degraded', '401: Unauthorized');

      try {
        await controller.ready();
        throw new Error('must have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ServiceUnavailableException);
        expect((e as ServiceUnavailableException).getResponse()).toMatchObject({
          status: 'degraded',
          db: 'up',
          integrations: { telegram: { status: 'degraded', detail: '401: Unauthorized' } },
        });
      }
    });

    it('is ok while the Telegram bootstrap is still starting (normal boot window)', async () => {
      state.setTelegram('starting');
      await expect(controller.ready()).resolves.toMatchObject({ status: 'ok' });
    });

    it('a degraded OpenRouter is reflected but does NOT fail readiness', async () => {
      state.setOpenRouter('degraded', 'rate-limited');

      const body = await controller.ready();
      expect(body.status).toBe('ok');
      expect(body.integrations.openRouter).toMatchObject({
        status: 'degraded',
        detail: 'rate-limited',
      });
    });

    it('the legacy GET /api/health alias returns the same readiness body', async () => {
      await expect(controller.check()).resolves.toMatchObject({
        status: 'ok',
        db: 'up',
        integrations: expect.any(Object),
      });
    });
  });
});
