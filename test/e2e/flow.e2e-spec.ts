import request from 'supertest';
import { DataSource } from 'typeorm';
import { INestApplication } from '@nestjs/common';
import { SweeperService } from '../../src/modules/telegram/sweeper.service';
import { AI_INACTIVE_MESSAGE } from '../../src/common/ticket-labels';
import { FakeTelegramGateway } from '../fakes/telegram-gateway.fake';
import { createTestApp } from '../testing/app-builder';

/**
 * End-to-end scenarios from the execution plan (§11), running against a REAL
 * PostgreSQL database with only the Telegram transport faked. The AI provider
 * is intentionally disabled (empty key) → the honest fallback reply.
 */
describe('AbrIT e2e flows (plan §11 scenarios)', () => {
  let app: INestApplication;
  let fakeGateway: FakeTelegramGateway;
  let ds: DataSource;
  let token: string;

  let nextUpdateId = 800_000;
  const webhookSecret = 'e2e-webhook-secret';

  const postUpdate = (update: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', webhookSecret)
      .send(update as object)
      .expect(200);

  const messageUpdate = (tgId: number, text: string) => ({
    update_id: nextUpdateId++,
    message: {
      message_id: nextUpdateId,
      from: { id: tgId, is_bot: false, first_name: `کاربر ${tgId}`, username: `u${tgId}` },
      chat: { id: tgId, type: 'private' },
      text,
    },
  });

  const count = async (table: string, where = '') =>
    Number(
      (
        await ds.query(`SELECT count(*)::int AS n FROM ${table}${where ? ' WHERE ' + where : ''}`)
      )[0].n,
    );

  const countAsync = (table: string, where: string) => count(table, where);

  async function waitFor(predicate: () => Promise<boolean>, ms = 4000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('waitFor: condition not met in time');
  }

  const assistantSent = (n: number) => waitFor(() =>
    count('messages', `role = 'ASSISTANT' AND delivery_status = 'SENT'`).then((c) => c === n),
  );

  const authed = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const built = await createTestApp();
    app = built.app;
    fakeGateway = built.fakeGateway;
    ds = app.get(DataSource);

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@abrit.local', password: 'Admin1234!' });
    expect(login.status).toBe(200);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE TABLE messages, tickets, telegram_users, bot_updates RESTART IDENTITY CASCADE');
    fakeGateway.reset();
  });

  it('GET /api/health is public and reports the DB as up', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'up' });
  });

  it('webhook rejects a wrong secret with 403', async () => {
    await request(app.getHttpServer())
      .post('/api/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'WRONG')
      .send(messageUpdate(910001, 'x'))
      .expect(403);
  });

  it('scenario 1/9: duplicate updates (even concurrent) create exactly one user, one ticket, one reply', async () => {
    const update = messageUpdate(910001, 'سلام، مشکل پرداخت دارم');
    await postUpdate(update);
    await postUpdate(update);
    await Promise.all([postUpdate(update), postUpdate(update), postUpdate(update)]);

    await assistantSent(1);

    expect(await count('telegram_users')).toBe(1);
    expect(await count('tickets')).toBe(1);
    expect(await count('messages', `role = 'USER'`)).toBe(1);
    const inbox = await ds.query('SELECT status, attempts FROM bot_updates');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].status).toBe('DONE');
    expect(Number(inbox[0].attempts)).toBe(1);
  });

  it('scenario 2/4: message without an active ticket → TKT-number ticket, subject, announcement, fallback reply delivered', async () => {
    await postUpdate(messageUpdate(910002, 'درگاه پرداخت خطا می‌دهد'));

    await assistantSent(1);

    const [ticket] = await ds.query('SELECT * FROM tickets');
    expect(ticket.ticket_number).toMatch(/^TKT-\d+$/);
    expect(ticket.status).toBe('OPEN');
    expect(ticket.subject).toBe('درگاه پرداخت خطا می‌دهد');

    const roles = (await ds.query('SELECT role FROM messages ORDER BY id')).map(
      (r: { role: string }) => r.role,
    );
    expect(roles).toEqual(['SYSTEM', 'USER', 'ASSISTANT']);

    const [reply] = await ds.query(`SELECT content, delivery_status, meta FROM messages WHERE role = 'ASSISTANT'`);
    expect(reply.delivery_status).toBe('SENT');
    expect(reply.content).toContain('ثبت شد'); // honest fallback (AI key intentionally empty)
    // the fake gateway delivered both announcement and reply
    expect(fakeGateway.sent.length).toBe(2);
  });

  it('scenario 3 (concurrency): 20 users in parallel → 20 distinct ticket numbers', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        postUpdate(messageUpdate(911_000 + i, `مشکل شماره ${i + 1}`)),
      ),
    );

    await waitFor(async () => (await count('tickets')) === 20);
    await assistantSent(20);

    const rows = await ds.query('SELECT ticket_number FROM tickets');
    const numbers = rows.map((r: { ticket_number: string }) => r.ticket_number);
    expect(new Set(numbers).size).toBe(20);
    for (const n of numbers) expect(n).toMatch(/^TKT-\d+$/);
  });

  it('scenario 12/13: closed ticket ⇒ next message opens a FRESH ticket; one active per user otherwise', async () => {
    await postUpdate(messageUpdate(910003, 'پیام اول'));
    await assistantSent(1);

    // second message continues in the SAME ticket
    await postUpdate(messageUpdate(910003, 'پیام دوم'));
    await assistantSent(2);
    expect(await count('tickets')).toBe(1);
    expect(await count('messages', `role = 'USER'`)).toBe(2);

    // admin closes the ticket via the panel API
    const [t1] = await ds.query('SELECT id FROM tickets');
    const res = await authed(
      request(app.getHttpServer()).patch(`/api/tickets/${t1.id}/status`).send({ status: 'CLOSED' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(true);

    // user writes again → a NEW ticket with a FRESH conversation (no old messages)
    await postUpdate(messageUpdate(910003, 'پیام بعد از بستن تیکت'));
    await waitFor(async () => (await count('tickets')) === 2);
    await assistantSent(3);

    expect(await count('tickets', `status = 'OPEN'`)).toBe(1); // one active per user
    const [newest] = await ds.query(
      'SELECT id FROM tickets ORDER BY created_at DESC LIMIT 1',
    );
    const newTicketMsgCount = await count('messages', `ticket_id = '${newest.id}'`);
    expect(newTicketMsgCount).toBe(3); // announcement + user message + reply — history stayed in the old ticket
  });

  it('scenario 6: ticket memories stay isolated between users', async () => {
    await postUpdate(messageUpdate(920001, 'متن محرمانه کاربر الف'));
    await postUpdate(messageUpdate(920002, 'متن محرمانه کاربر ب'));
    await assistantSent(2);

    const tickets = await ds.query(
      'SELECT t.id, u.telegram_id FROM tickets t JOIN telegram_users u ON u.id = t.user_id',
    );
    const ticketA = tickets.find((t: { telegram_id: string }) => t.telegram_id === '920001');
    const ticketB = tickets.find((t: { telegram_id: string }) => t.telegram_id === '920002');
    expect(ticketA).toBeTruthy();
    expect(ticketB).toBeTruthy();

    const msgsA = await ds.query(`SELECT content FROM messages WHERE ticket_id = '${ticketA.id}'`);
    const msgsB = await ds.query(`SELECT content FROM messages WHERE ticket_id = '${ticketB.id}'`);

    expect(JSON.stringify(msgsA)).toContain('کاربر الف');
    expect(JSON.stringify(msgsA)).not.toContain('کاربر ب');
    expect(JSON.stringify(msgsB)).toContain('کاربر ب');
    expect(JSON.stringify(msgsB)).not.toContain('کاربر الف');
  });

  it('scenario 14: AI disabled from the panel → fixed "recorded" reply (no provider call)', async () => {
    await authed(
      request(app.getHttpServer()).patch('/api/settings/assistant').send({ is_active: false }),
    ).expect(200);

    await postUpdate(messageUpdate(910004, 'سلام'));
    await assistantSent(1);

    const [reply] = await ds.query(`SELECT content, meta FROM messages WHERE role = 'ASSISTANT'`);
    expect(reply.content).toBe(AI_INACTIVE_MESSAGE);
    expect(reply.meta.reason).toBe('assistant-disabled-by-admin');

    // restore for the remaining tests
    await authed(
      request(app.getHttpServer()).patch('/api/settings/assistant').send({ is_active: true }),
    ).expect(200);
  });

  it('scenario 7: status transitions — 400 invalid, no-op same status, notification SENT, 409 reopen with other active ticket', async () => {
    await postUpdate(messageUpdate(930001, 'مشکل تست وضعیت'));
    await assistantSent(1);
    const [t] = await ds.query('SELECT * FROM tickets');
    const api = `/api/tickets/${t.id}/status`;

    // invalid status value
    await authed(request(app.getHttpServer()).patch(api).send({ status: 'BROKEN' })).expect(400);

    // same status → no-op (200, no duplicate notification)
    const noop = await authed(
      request(app.getHttpServer()).patch(api).send({ status: 'OPEN' }),
    ).expect(200);
    expect(noop.body.data.changed).toBe(false);

    // valid transition → durable SYSTEM notification delivered via the gateway (async)
    const changed = await authed(
      request(app.getHttpServer()).patch(api).send({ status: 'IN_PROGRESS' }),
    ).expect(200);
    expect(changed.body.data.changed).toBe(true);

    await waitFor(async () => {
      const rows = await ds.query(
        `SELECT delivery_status FROM messages WHERE role = 'SYSTEM' AND content LIKE '%در حال بررسی%'`,
      );
      return rows.length === 1 && rows[0].delivery_status === 'SENT';
    });

    const [sys] = await ds.query(
      `SELECT * FROM messages WHERE role = 'SYSTEM' AND content LIKE '%در حال بررسی%'`,
    );
    expect(sys.delivery_status).toBe('SENT');
    expect(sys.content).toContain(t.ticket_number);

    // close, let the user open a new ticket, then try to reopen the old one → 409
    await authed(request(app.getHttpServer()).patch(api).send({ status: 'CLOSED' })).expect(200);
    await postUpdate(messageUpdate(930001, 'مشکل جدید'));
    await waitFor(async () => (await count('tickets')) === 2);

    const reopen = await authed(request(app.getHttpServer()).patch(api).send({ status: 'OPEN' }));
    expect(reopen.status).toBe(409);
  });

  it('scenario 11: admin endpoints reject missing/invalid tokens with 401', async () => {
    const server = app.getHttpServer();
    const cases: [() => request.Test, number][] = [
      [() => request(server).get('/api/dashboard/stats'), 401],
      [() => request(server).get('/api/tickets'), 401],
      [() => request(server).get('/api/users'), 401],
      [() => request(server).get('/api/settings/assistant'), 401],
      [() => request(server).get('/api/tickets/00000000-0000-0000-0000-000000000000/messages'), 401],
      [
        () =>
          request(server)
            .patch('/api/tickets/00000000-0000-0000-0000-000000000000/status')
            .send({ status: 'OPEN' }),
        401,
      ],
    ];
    for (const [make, expected] of cases) {
      const res = await make();
      expect(res.status).toBe(expected);
    }
    // garbage token
    const garbage = await request(server)
      .get('/api/tickets')
      .set('Authorization', 'Bearer not-a-jwt');
    expect(garbage.status).toBe(401);
  });

  it('lists return { data, meta } with server-side pagination', async () => {
    for (let i = 0; i < 3; i++) {
      await postUpdate(messageUpdate(912_000 + i, `درخواست شماره ${i + 1}`));
    }
    await assistantSent(3);

    const list = await authed(
      request(app.getHttpServer()).get('/api/tickets?page=1&limit=2'),
    ).expect(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.meta).toMatchObject({ page: 1, limit: 2, total: 3 });

    const users = await authed(request(app.getHttpServer()).get('/api/users')).expect(200);
    expect(users.body.meta.total).toBe(3);
  });

  it('sweeper re-drives updates left RECEIVED by a crash (boot/between ingest and enqueue)', async () => {
    // simulate: the process died right after storing the update, before processing
    const payload = messageUpdate(940001, 'پیام بعد از کرش');
    await ds.query(`INSERT INTO bot_updates (update_id, payload, status) VALUES ($1, $2, 'RECEIVED')`, [
      String(payload.update_id),
      JSON.stringify(payload),
    ]);

    const sweeper = app.get(SweeperService);
    await sweeper.sweep('cron');

    await assistantSent(1);
    expect(await count('tickets')).toBe(1);
    const inbox = await ds.query(`SELECT status FROM bot_updates WHERE update_id = '${payload.update_id}'`);
    expect(inbox[0].status).toBe('DONE');
  });

  it('login rejects wrong credentials with 401', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@abrit.local', password: 'wrong-password' })
      .expect(401);
  });
});
