import request from 'supertest';
import { DataSource } from 'typeorm';
import { INestApplication } from '@nestjs/common';
import { createTestApp } from '../testing/app-builder';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '../../src/modules/auth/session-cookies';

/**
 * Review round 6 — P1 (Telegram bootstrap degradation → readiness probe) and
 * P2 (session security: HttpOnly cookie + CSRF double-submit).
 *
 * The Telegram token is EMPTY in the e2e environment, so the integration is
 * `disabled` — exactly the state that must stay readiness-ok. The cookie suite
 * drives the REAL guards (throttle → JWT → CSRF) through the real HTTP server.
 * Login is rate-limited to 5/min/IP, so the suite logs in ONCE and reuses the
 * cookie jar (2 more login calls max — under the limit).
 */
describe('Round 6 — liveness/readiness split & session cookies', () => {
  let app: INestApplication;
  let ds: DataSource;
  let jar: Record<string, string>; // cookie jar of the shared session
  let accessToken: string; // body token of the shared session (Bearer/API clients)

  /** supertest exposes set-cookie as string[] — map name → value. */
  const cookiesOf = (res: request.Response): Record<string, string> => {
    const parsed: Record<string, string> = {};
    const raw = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const line of list) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      parsed[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    return parsed;
  };

  const rawCookiesOf = (res: request.Response): string[] => {
    const raw = res.headers['set-cookie'];
    return Array.isArray(raw) ? raw : raw ? [raw] : [];
  };

  beforeAll(async () => {
    const built = await createTestApp();
    app = built.app;
    ds = app.get(DataSource);

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@abrit.local', password: 'Admin1234!' })
      .expect(200);
    jar = cookiesOf(login);
    accessToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('health split (P1: a dead bot must never look healthy)', () => {
    it('GET /api/health/live is public and reports the process alive (no external checks)', async () => {
      const res = await request(app.getHttpServer()).get('/api/health/live').expect(200);
      expect(res.body).toMatchObject({ status: 'ok' });
      expect(res.body.integrations).toBeUndefined(); // liveness consults NOTHING
    });

    it('GET /api/health/ready is public: db up, integrations reflected, token empty → telegram disabled → 200', async () => {
      const res = await request(app.getHttpServer()).get('/api/health/ready').expect(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        db: 'up',
        integrations: {
          telegram: { status: 'disabled' },
          openRouter: { status: 'disabled' },
        },
      });
    });

    it('the legacy GET /api/health keeps its readiness semantics for old tooling', async () => {
      const res = await request(app.getHttpServer()).get('/api/health').expect(200);
      expect(res.body).toMatchObject({ status: 'ok', db: 'up' });
      expect(res.body.integrations).toBeDefined();
    });
  });

  describe('HttpOnly session + CSRF double submit (P2)', () => {
    it('login set an HttpOnly session cookie (SameSite=Strict) plus a readable CSRF cookie', async () => {
      expect(jar[SESSION_COOKIE_NAME]).toBeTruthy();
      expect(jar[CSRF_COOKIE_NAME]).toBeTruthy();

      const sessionLine = rawCookiesOf(
        await request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ email: 'admin@abrit.local', password: 'Admin1234!' })
          .expect(200),
      ).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));

      expect(sessionLine).toContain('HttpOnly');
      expect(sessionLine).toMatch(/SameSite=Strict/i);
      // the body token still exists for API clients (Bearer stays supported)
      expect(accessToken).toBeTruthy();
    });

    it('the CSRF cookie is deliberately readable — no HttpOnly (the panel echoes it in a header)', async () => {
      const csrfLine = rawCookiesOf(
        await request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ email: 'admin@abrit.local', password: 'Admin1234!' })
          .expect(200),
      ).find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`));
      expect(csrfLine).toBeTruthy();
      expect(csrfLine).not.toContain('HttpOnly');
    });

    it('GET /api/auth/me restores the session from the cookie ALONE (no localStorage token anymore)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', `${SESSION_COOKIE_NAME}=${jar[SESSION_COOKIE_NAME]}`)
        .expect(200);

      expect(res.body.admin).toMatchObject({ email: 'admin@abrit.local' });
      expect(JSON.stringify(res.body)).not.toContain('password_hash');
    });

    it('GET /api/auth/me without any credential is 401', async () => {
      await request(app.getHttpServer()).get('/api/auth/me').expect(401);
    });

    describe('mutations against a real ticket', () => {
      let ticketId: string;

      beforeAll(async () => {
        // created through the secret-protected webhook — the REAL pipeline
        // (registration → wizard: the only ticket path in the feature round)
        const post = (update: Record<string, unknown>) =>
          request(app.getHttpServer())
            .post('/api/telegram/webhook')
            .set('x-telegram-bot-api-secret-token', 'e2e-webhook-secret')
            .send(update)
            .expect(200);
        await post({
          update_id: 9_700_001,
          message: {
            message_id: 9_700_001,
            from: { id: 9_700_100, is_bot: false, first_name: 'کاربر کوکی' },
            chat: { id: 9_700_100, type: 'private' },
            text: '/start',
          },
        });
        await post({
          update_id: 9_700_002,
          message: {
            message_id: 9_700_002,
            from: { id: 9_700_100, is_bot: false },
            chat: { id: 9_700_100, type: 'private' },
            text: 'کاربر کوکی کامل',
          },
        });
        await post({
          update_id: 9_700_003,
          message: {
            message_id: 9_700_003,
            from: { id: 9_700_100, is_bot: false },
            chat: { id: 9_700_100, type: 'private' },
            text: '09121234567',
          },
        });
        await post({
          update_id: 9_700_004,
          message: {
            message_id: 9_700_004,
            from: { id: 9_700_100, is_bot: false },
            chat: { id: 9_700_100, type: 'private' },
            text: '/new',
          },
        });
        await post({
          update_id: 9_700_005,
          message: {
            message_id: 9_700_005,
            from: { id: 9_700_100, is_bot: false },
            chat: { id: 9_700_100, type: 'private' },
            text: 'تیکت تست CSRF',
          },
        });
        await post({
          update_id: 9_700_006,
          message: {
            message_id: 9_700_006,
            from: { id: 9_700_100, is_bot: false },
            chat: { id: 9_700_100, type: 'private' },
            text: '💰 مالی',
          },
        });
        await post({
          update_id: 9_700_007,
          message: {
            message_id: 9_700_007,
            from: { id: 9_700_100, is_bot: false },
            chat: { id: 9_700_100, type: 'private' },
            text: 'متن کامل درخواست برای تست CSRF',
          },
        });
        // the wizard finalizes asynchronously — wait for the ticket to exist
        const deadline = Date.now() + 5000;
        let ticket: { id: string } | undefined;
        while (Date.now() < deadline) {
          const rows = await ds.query(`SELECT id FROM tickets ORDER BY created_at DESC LIMIT 1`);
          if (rows.length > 0) {
            ticket = rows[0];
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        ticketId = ticket!.id;
      });

      it('a cookie-authenticated MUTATION without the CSRF header is 403 (forgery blocked)', async () => {
        await request(app.getHttpServer())
          .patch(`/api/tickets/${ticketId}/status`)
          .set('Cookie', `${SESSION_COOKIE_NAME}=${jar[SESSION_COOKIE_NAME]}`)
          .send({ status: 'IN_PROGRESS' })
          .expect(403);
      });

      it('the SAME mutation WITH the matching X-CSRF-Token header succeeds', async () => {
        await request(app.getHttpServer())
          .patch(`/api/tickets/${ticketId}/status`)
          .set('Cookie', [
            `${SESSION_COOKIE_NAME}=${jar[SESSION_COOKIE_NAME]}`,
            `${CSRF_COOKIE_NAME}=${jar[CSRF_COOKIE_NAME]}`,
          ].join('; '))
          .set('X-CSRF-Token', jar[CSRF_COOKIE_NAME])
          .send({ status: 'IN_PROGRESS' })
          .expect(200);
      });

      it('a MISMATCHING CSRF token is 403 (token reuse across sessions does not help)', async () => {
        await request(app.getHttpServer())
          .patch(`/api/tickets/${ticketId}/status`)
          .set('Cookie', [
            `${SESSION_COOKIE_NAME}=${jar[SESSION_COOKIE_NAME]}`,
            `${CSRF_COOKIE_NAME}=${jar[CSRF_COOKIE_NAME]}`,
          ].join('; '))
          .set('X-CSRF-Token', 'attacker-guess')
          .send({ status: 'IN_PROGRESS' })
          .expect(403);
      });

      it('cookie-authenticated READS never need a CSRF token (GET is safe)', async () => {
        await request(app.getHttpServer())
          .get('/api/tickets')
          .set('Cookie', `${SESSION_COOKIE_NAME}=${jar[SESSION_COOKIE_NAME]}`)
          .expect(200);
      });

      it('Bearer requests stay CSRF-exempt — API clients and Swagger are unaffected', async () => {
        await request(app.getHttpServer())
          .get('/api/tickets')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);
      });
    });

    it('logout clears BOTH cookies; the session no longer authenticates', async () => {
      // dedicated login (the shared jar must survive for other tests)
      const fresh = cookiesOf(
        await request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ email: 'admin@abrit.local', password: 'Admin1234!' })
          .expect(200),
      );

      const res = await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Cookie', [
          `${SESSION_COOKIE_NAME}=${fresh[SESSION_COOKIE_NAME]}`,
          `${CSRF_COOKIE_NAME}=${fresh[CSRF_COOKIE_NAME]}`,
        ].join('; '))
        .expect(200);

      const cleared = cookiesOf(res);
      // express clears by sending an expired/empty value
      expect(cleared[SESSION_COOKIE_NAME]).toBe('');
      expect(cleared[CSRF_COOKIE_NAME]).toBe('');

      // the browser would drop the cookie — a fresh request carries nothing
      await request(app.getHttpServer()).get('/api/auth/me').expect(401);
    });

    it('a bad login is still a clean 401 (guards never crash the request)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'wrong@abrit.local', password: 'nope' })
        .expect(401);
    });
  });
});
