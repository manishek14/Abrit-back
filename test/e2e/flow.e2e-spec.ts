import request from 'supertest';
import { DataSource } from 'typeorm';
import { INestApplication } from '@nestjs/common';
import { io as socketIoClient } from 'socket.io-client';
import { SweeperService } from '../../src/modules/telegram/sweeper.service';
import { OutboxDispatcherService } from '../../src/modules/telegram/outbox-dispatcher.service';
import { MessagesService } from '../../src/modules/messages/messages.service';
import { TelegramApiError } from '../../src/modules/telegram/telegram-gateway.interface';
import { InboxRetentionService } from '../../src/modules/inbox/inbox-retention.service';
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

  /* ------------------------------------------------------------------ */
  /* Review fixes — crash recovery, outbox concurrency, validation      */
  /* ------------------------------------------------------------------ */

  /** Simulates the exact DB state a crash leaves behind after addUserMessage. */
  async function seedCrashedAfterUserMessage(
    tgId: number,
    text: string,
    withReply: boolean,
  ): Promise<void> {
    const payload = messageUpdate(tgId, text);
    const [user] = await ds.query(
      `INSERT INTO telegram_users (telegram_id, chat_id, first_name) VALUES ($1, $1, 'کاربر تست کرش') RETURNING *`,
      [String(tgId)],
    );
    const [ticket] = await ds.query(
      `INSERT INTO tickets (user_id, subject) VALUES ($1, $2) RETURNING *`,
      [user.id, 'بازیابی پس از کرش'],
    );
    const [userMessage] = await ds.query(
      `INSERT INTO messages (ticket_id, role, content, telegram_update_id) VALUES ($1, 'USER', $2, $3) RETURNING id`,
      [ticket.id, text, String(payload.update_id)],
    );
    if (withReply) {
      await ds.query(
        `INSERT INTO messages (ticket_id, role, content, in_reply_to_id, delivery_status, sent_at)
         VALUES ($1, 'ASSISTANT', 'پاسخ قبلی', $2, 'SENT', now())`,
        [ticket.id, userMessage.id],
      );
    }
    await ds.query(
      `INSERT INTO bot_updates (update_id, payload, status, stage) VALUES ($1, $2, 'RECEIVED', 'USER_SAVED')`,
      [String(payload.update_id), JSON.stringify(payload)],
    );
  }

  it('CRASH RECOVERY #1a: user message stored but reply missing → re-run RESUMES and answers', async () => {
    await seedCrashedAfterUserMessage(950001, 'پیام بعد از کرش', false);

    await app.get(SweeperService).sweep('cron');
    await assistantSent(1);

    // exactly one user message, one reply — the crash no longer swallows the answer
    expect(await count('messages', `role = 'USER'`)).toBe(1);
    expect(await count('messages', `role = 'ASSISTANT'`)).toBe(1);
    const [update] = await ds.query(`SELECT status, stage, last_error FROM bot_updates`);
    expect(update.status).toBe('DONE');
    expect(update.stage).toBe('REPLY_SAVED');
    expect(update.last_error).toBeNull();
  });

  it('CRASH RECOVERY #1b: reply already stored → re-run finishes WITHOUT a second AI reply or resend', async () => {
    await seedCrashedAfterUserMessage(950002, 'پیام کامل‌شده', true);

    await app.get(SweeperService).sweep('cron');
    await waitFor(async () => {
      const [u] = await ds.query(`SELECT status FROM bot_updates`);
      return u?.status === 'DONE';
    });

    expect(await count('messages', `role = 'USER'`)).toBe(1);
    expect(await count('messages', `role = 'ASSISTANT'`)).toBe(1);
    expect(fakeGateway.sent).toHaveLength(0); // nothing was re-delivered
  });

  it('CRASH RECOVERY #1c: last_error is preserved when a poisoned update exhausts its attempts', async () => {
    await postUpdate(messageUpdate(950003, 'خطای موقت'));
    await assistantSent(1);

    // simulate a worker that kept failing on this update and finally died:
    // stale lock, max attempts, and a recorded last_error
    const [row] = await ds.query(`SELECT update_id FROM bot_updates LIMIT 1`);
    await ds.query(
      `UPDATE bot_updates SET status = 'PROCESSING', locked_at = now() - interval '10 minutes',
       attempts = 3, last_error = 'simulated persistent failure' WHERE update_id = $1`,
      [row.update_id],
    );

    await app.get(SweeperService).sweep('cron');

    const [dead] = await ds.query(
      `SELECT status, last_error FROM bot_updates WHERE update_id = $1`,
      [row.update_id],
    );
    expect(dead.status).toBe('FAILED'); // attempts exhausted — no infinite retries
    expect(dead.last_error).toBe('simulated persistent failure'); // NOT overwritten by 'abandoned'
  });

  it('OUTBOX CONCURRENCY #2a: two concurrent deliver() calls → exactly ONE Telegram send', async () => {
    const [user] = await ds.query(
      `INSERT INTO telegram_users (telegram_id, chat_id) VALUES ('950100', '950100') RETURNING *`,
    );
    const [ticket] = await ds.query(
      `INSERT INTO tickets (user_id, subject) VALUES ($1, 'هم‌زمانی') RETURNING *`,
      [user.id],
    );
    const [msg] = await ds.query(
      `INSERT INTO messages (ticket_id, role, content, delivery_status) VALUES ($1, 'ASSISTANT', 'تست هم‌زمانی', 'PENDING') RETURNING *`,
      [ticket.id],
    );

    const dispatcher = app.get(OutboxDispatcherService);
    await Promise.all([dispatcher.deliver(msg), dispatcher.deliver(msg)]);

    expect(fakeGateway.sent.filter((s) => s.text === 'تست هم‌زمانی')).toHaveLength(1);
    const [after] = await ds.query(`SELECT delivery_status FROM messages WHERE id = $1`, [msg.id]);
    expect(after.delivery_status).toBe('SENT');
  });

  it('OUTBOX LEASE #2b: a fresh claim blocks the sweeper; a stale lease is reclaimed and delivered', async () => {
    const [user] = await ds.query(
      `INSERT INTO telegram_users (telegram_id, chat_id) VALUES ('950200', '950200') RETURNING *`,
    );
    const [ticket] = await ds.query(
      `INSERT INTO tickets (user_id, subject) VALUES ($1, 'لیز') RETURNING *`,
      [user.id],
    );
    const [msg] = await ds.query(
      `INSERT INTO messages (ticket_id, role, content, delivery_status, claimed_at, created_at)
       VALUES ($1, 'ASSISTANT', 'پیام با قفل', 'PENDING', now(), now() - interval '1 minute') RETURNING *`,
      [ticket.id],
    );

    // someone else owns a FRESH claim → the sweeper must skip it entirely
    await app.get(SweeperService).sweep('cron');
    expect(fakeGateway.sent.filter((s) => s.text === 'پیام با قفل')).toHaveLength(0);
    const [row] = await ds.query(
      `SELECT delivery_status, delivery_attempts FROM messages WHERE id = $1`,
      [msg.id],
    );
    expect(row.delivery_status).toBe('PENDING');
    expect(row.delivery_attempts).toBe(0); // a LOST claim consumes no attempt

    // the claimant crashed — after the lease expires the sweeper reclaims it
    await ds.query(`UPDATE messages SET claimed_at = now() - interval '2 minutes' WHERE id = $1`, [msg.id]);
    await app.get(SweeperService).sweep('cron');
    await waitFor(async () => {
      const [r] = await ds.query(`SELECT delivery_status FROM messages WHERE id = $1`, [msg.id]);
      return r.delivery_status === 'SENT';
    });
    expect(fakeGateway.sent.filter((s) => s.text === 'پیام با قفل')).toHaveLength(1);
    const [reclaimed] = await ds.query(
      `SELECT delivery_attempts FROM messages WHERE id = $1`,
      [msg.id],
    );
    // CRASH-SAFE ATTEMPT COUNTING (review fix): the crashed sender's stale
    // claim still consumed ONE of the MAX_DELIVERY_ATTEMPTS retries.
    expect(reclaimed.delivery_attempts).toBe(1);
  });

  it('STATUS #4-a: CLOSED → IN_PROGRESS with another active ticket → 409, never a 500', async () => {
    await postUpdate(messageUpdate(950300, 'تیکت اول'));
    await assistantSent(1);
    const tickets = await ds.query(`SELECT id FROM tickets ORDER BY created_at ASC`);
    const first = tickets[0];

    await authed(
      request(app.getHttpServer()).patch(`/api/tickets/${first.id}/status`).send({ status: 'CLOSED' }),
    ).expect(200);

    await postUpdate(messageUpdate(950300, 'تیکت دوم'));
    await waitFor(async () => (await count('tickets')) === 2);

    const res = await authed(
      request(app.getHttpServer()).patch(`/api/tickets/${first.id}/status`).send({ status: 'IN_PROGRESS' }),
    );
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('another active ticket');
  });

  it('PAGINATION: before-cursor pages + has_more + cursor input validation', async () => {
    const [user] = await ds.query(
      `INSERT INTO telegram_users (telegram_id, chat_id) VALUES ('950400', '950400') RETURNING *`,
    );
    const [ticket] = await ds.query(
      `INSERT INTO tickets (user_id, subject) VALUES ($1, 'صفحه‌بندی') RETURNING *`,
      [user.id],
    );
    for (let i = 1; i <= 6; i++) {
      await ds.query(
        `INSERT INTO messages (ticket_id, role, content) VALUES ($1, 'USER', $2)`,
        [ticket.id, `پیام ${i}`],
      );
    }
    const ids = (await ds.query(`SELECT id FROM messages ORDER BY id`)).map(
      (r: { id: string }) => r.id,
    );
    expect(ids).toHaveLength(6);

    const api = `/api/tickets/${ticket.id}/messages`;

    // full load
    const all = await authed(request(app.getHttpServer()).get(api)).expect(200);
    expect(all.body.data).toHaveLength(6);
    expect(all.body.meta.has_more).toBe(false);

    // before-cursor: everything older than message 4
    const older = await authed(
      request(app.getHttpServer()).get(`${api}?before=${ids[3]}`),
    ).expect(200);
    expect(older.body.data.map((m: { id: string }) => m.id)).toEqual(ids.slice(0, 3));
    expect(older.body.meta.has_more).toBe(false);

    // before-cursor with a page size: the 2 closest to the cursor, has_more = true
    const page = await authed(
      request(app.getHttpServer()).get(`${api}?before=${ids[3]}&limit=2`),
    ).expect(200);
    expect(page.body.data.map((m: { id: string }) => m.id)).toEqual(ids.slice(1, 3));
    expect(page.body.meta.has_more).toBe(true);

    // input validation
    await authed(request(app.getHttpServer()).get(`${api}?after=abc`)).expect(400);
    await authed(
      request(app.getHttpServer()).get(`${api}?after=99999999999999999999`),
    ).expect(400); // 20 digits > bigint
    await authed(request(app.getHttpServer()).get(`${api}?after=1&before=2`)).expect(400);
    await authed(request(app.getHttpServer()).get(`${api}?limit=0`)).expect(400);
  });

  it('PAGINATION (P0 fix): a long conversation lands on the NEWEST slice; load-older walks backward', async () => {
    const [user] = await ds.query(
      `INSERT INTO telegram_users (telegram_id, chat_id) VALUES ('950410', '950410') RETURNING *`,
    );
    const [ticket] = await ds.query(
      `INSERT INTO tickets (user_id, subject) VALUES ($1, 'صفحه‌بندی جدید') RETURNING *`,
      [user.id],
    );
    for (let i = 1; i <= 12; i++) {
      await ds.query(
        `INSERT INTO messages (ticket_id, role, content) VALUES ($1, 'USER', $2)`,
        [ticket.id, `پیام ${i}`],
      );
    }
    const ids = (await ds.query(`SELECT id FROM messages ORDER BY id`)).map(
      (r: { id: string }) => r.id,
    );
    const api = `/api/tickets/${ticket.id}/messages`;

    // initial page (no cursor): the LATEST 5, ascending — the agent sees the
    // conversation's newest state first, and has_more points at older history.
    const first = await authed(request(app.getHttpServer()).get(`${api}?limit=5`)).expect(200);
    expect(first.body.data.map((m: { id: string }) => m.id)).toEqual(ids.slice(7, 12));
    expect(first.body.meta.has_more).toBe(true);

    // "load older" with the oldest cached id prepends the 5 messages before it
    const older = await authed(
      request(app.getHttpServer()).get(`${api}?before=${ids[7]}&limit=5`),
    ).expect(200);
    expect(older.body.data.map((m: { id: string }) => m.id)).toEqual(ids.slice(2, 7));
    expect(older.body.meta.has_more).toBe(true);

    // the last older page is short and reports has_more = false
    const last = await authed(
      request(app.getHttpServer()).get(`${api}?before=${ids[2]}&limit=5`),
    ).expect(200);
    expect(last.body.data.map((m: { id: string }) => m.id)).toEqual(ids.slice(0, 2));
    expect(last.body.meta.has_more).toBe(false);

    // after-cursor still refreshes incrementally (newer than the cursor)
    const fresh = await authed(
      request(app.getHttpServer()).get(`${api}?after=${ids[10]}`),
    ).expect(200);
    expect(fresh.body.data.map((m: { id: string }) => m.id)).toEqual(ids.slice(11, 12));
  });

  it('ADMIN REPLY: panel reply → ADMIN outbox row → Telegram delivery + realtime badges + last-activity bump', async () => {
    await postUpdate(messageUpdate(950800, 'سلام، منتظر پاسخ هستم'));
    await assistantSent(1);

    const [ticket] = await ds.query(`SELECT id, last_message_at FROM tickets`);
    const before = new Date(ticket.last_message_at as string);

    // realtime: the panel must see the reply the moment it commits and its
    // delivery badge when the outbox finishes the send.
    const url = await app.getUrl();
    const socket = socketIoClient(url, { auth: { token }, transports: ['websocket'] });
    const nextEvent = (event: string, timeoutMs = 5000): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
        socket.once(event, (payload: Record<string, unknown>) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', (err: Error) => reject(err));
      });

      const messageEvent = nextEvent('message:new');
      const sentEvent = nextEvent('message:updated');

      const res = await authed(
        request(app.getHttpServer()).post(`/api/tickets/${ticket.id}/messages`).send({
          content: '  پاسخ کارشناس  ',
        }),
      ).expect(201);
      expect(res.body.data).toMatchObject({
        role: 'ADMIN',
        content: 'پاسخ کارشناس', // trimmed
        delivery_status: 'PENDING',
      });
      expect(typeof res.body.data.admin_id).toBe('string');

      await expect(messageEvent).resolves.toMatchObject({
        message: { role: 'ADMIN', content: 'پاسخ کارشناس', delivery_status: 'PENDING' },
      });
      await expect(sentEvent).resolves.toMatchObject({
        message: { role: 'ADMIN', delivery_status: 'SENT' },
      });

      // the durable outbox delivered the reply to the user's chat exactly once
      expect(fakeGateway.sent.filter((s) => s.text === 'پاسخ کارشناس')).toHaveLength(1);

      // ticket's last-activity stamp advanced in the same transaction
      const [afterTicket] = await ds.query(
        `SELECT last_message_at FROM tickets WHERE id = $1`,
        [ticket.id],
      );
      expect(new Date(afterTicket.last_message_at as string).getTime()).toBeGreaterThan(
        before.getTime() - 1,
      );
    } finally {
      socket.close();
    }

    // input validation
    const beforeMessages = await count('messages');
    await authed(
      request(app.getHttpServer()).post(`/api/tickets/${ticket.id}/messages`).send({ content: '' }),
    ).expect(400);
    await authed(
      request(app.getHttpServer()).post(`/api/tickets/${ticket.id}/messages`).send({ content: 'x'.repeat(4001) }),
    ).expect(400);
    await authed(
      request(app.getHttpServer()).post(`/api/tickets/${ticket.id}/messages`).send({}),
    ).expect(400);

    // WHITESPACE-ONLY fix: content that is spaces only must be rejected with
    // 400 at the DTO (trim-before-validate), never stored as an empty message.
    await authed(
      request(app.getHttpServer())
        .post(`/api/tickets/${ticket.id}/messages`)
        .send({ content: '     \n\t  ' }),
    ).expect(400);
    expect(await count('messages')).toBe(beforeMessages);

    // a CLOSED ticket refuses new replies with 409 — reopen first
    await authed(
      request(app.getHttpServer()).patch(`/api/tickets/${ticket.id}/status`).send({ status: 'CLOSED' }),
    ).expect(200);
    await authed(
      request(app.getHttpServer()).post(`/api/tickets/${ticket.id}/messages`).send({ content: 'بعد از بستن' }),
    ).expect(409);
  });

  it('ADMIN REPLY IDEMPOTENCY: a retry with the SAME client_message_id replays the original — never a duplicate send', async () => {
    await postUpdate(messageUpdate(950801, 'سلام، پیگیری می‌کنم'));
    await assistantSent(1);
    const [ticket] = await ds.query(`SELECT id FROM tickets`);

    const first = await authed(
      request(app.getHttpServer())
        .post(`/api/tickets/${ticket.id}/messages`)
        .send({ content: 'پاسخ یکتا', client_message_id: 'e2e-idem-key-0001' }),
    ).expect(201);
    expect(first.body.data).toMatchObject({
      role: 'ADMIN',
      content: 'پاسخ یکتا',
      client_message_id: 'e2e-idem-key-0001',
    });

    // the operator retried because the first HTTP response was lost
    const replay = await authed(
      request(app.getHttpServer())
        .post(`/api/tickets/${ticket.id}/messages`)
        .send({ content: 'پاسخ یکتا', client_message_id: 'e2e-idem-key-0001' }),
    ).expect(200); // idempotent replay — NOT a new create
    expect(replay.body.data.id).toBe(first.body.data.id);

    // exactly ONE ADMIN row and exactly ONE Telegram delivery
    expect(await count('messages', `role = 'ADMIN'`)).toBe(1);
    await waitFor(async () =>
      count('messages', `role = 'ADMIN' AND delivery_status = 'SENT'`).then((c) => c === 1),
    );
    expect(fakeGateway.sent.filter((s) => s.text === 'پاسخ یکتا')).toHaveLength(1);

    // a malformed idempotency key is rejected up front
    await authed(
      request(app.getHttpServer())
        .post(`/api/tickets/${ticket.id}/messages`)
        .send({ content: 'پاسخ', client_message_id: 'short!' }),
    ).expect(400);
  });

  it('ADMIN REPLY IDEMPOTENCY (content-bound): the SAME key with DIFFERENT content is a 409, never a replay', async () => {
    await postUpdate(messageUpdate(950802, 'سلام، ویرایش پاسخ'));
    await assistantSent(1);
    const [ticket] = await ds.query(`SELECT id FROM tickets`);

    const first = await authed(
      request(app.getHttpServer())
        .post(`/api/tickets/${ticket.id}/messages`)
        .send({ content: 'پاسخ اول', client_message_id: 'e2e-idem-key-0002' }),
    ).expect(201);

    // the operator EDITED the draft but (bug/stale tab) reused the old key:
    // answering with the original message would wipe text that was never sent
    await authed(
      request(app.getHttpServer())
        .post(`/api/tickets/${ticket.id}/messages`)
        .send({ content: 'پاسخ ویرایش‌شده', client_message_id: 'e2e-idem-key-0002' }),
    ).expect(409);

    // nothing new was stored and the original row is intact
    expect(await count('messages', `role = 'ADMIN'`)).toBe(1);
    const [stored] = await ds.query(`SELECT content FROM messages WHERE role = 'ADMIN'`);
    expect(stored.content).toBe('پاسخ اول');

    // the honest path works: an edited draft with a FRESH key is a new message
    const edited = await authed(
      request(app.getHttpServer())
        .post(`/api/tickets/${ticket.id}/messages`)
        .send({ content: 'پاسخ ویرایش‌شده', client_message_id: 'e2e-idem-key-0003' }),
    ).expect(201);
    expect(edited.body.data.id).not.toBe(first.body.data.id);
    expect(await count('messages', `role = 'ADMIN'`)).toBe(2);
  });

  it('ORDERING GATE (review fix): a later message of the same chat waits while an earlier one is unfinished', async () => {
    await postUpdate(messageUpdate(950810, 'پیام اول'));
    await assistantSent(1);

    // simulate a crash AFTER message 1 was stored: its reply is gone and the
    // row sits in stale PROCESSING — the sweeper will retry it, but until then
    // it has NOT reached a terminal state
    await ds.query(`DELETE FROM messages WHERE role = 'ASSISTANT'`);
    const [firstUpdate] = await ds.query(
      `SELECT update_id FROM bot_updates ORDER BY update_id ASC LIMIT 1`,
    );
    await ds.query(
      `UPDATE bot_updates SET status = 'PROCESSING', stage = 'USER_SAVED',
       locked_at = now() - interval '3 minutes' WHERE update_id = $1`,
      [firstUpdate.update_id],
    );

    // message 2 arrives — it must NOT overtake the unfinished message 1
    await postUpdate(messageUpdate(950810, 'پیام دوم'));
    await new Promise((r) => setTimeout(r, 600)); // let the enqueue path settle

    const [second] = await ds.query(
      `SELECT status, attempts FROM bot_updates WHERE update_id > $1 ORDER BY update_id ASC LIMIT 1`,
      [firstUpdate.update_id],
    );
    expect(second.status).toBe('RECEIVED'); // waiting — not claimed
    expect(second.attempts).toBe(0); // and no attempt burned while waiting
    expect(await count('messages', `role = 'USER'`)).toBe(1); // only message 1 is stored
    expect(await count('messages', `role = 'ASSISTANT'`)).toBe(0); // its reply is pending the retry

    // the sweeper finishes message 1 FIRST, only then message 2 runs
    await app.get(SweeperService).sweep('cron');
    await assistantSent(2);

    const [first] = await ds.query(`SELECT status FROM bot_updates WHERE update_id = $1`, [
      firstUpdate.update_id,
    ]);
    expect(first.status).toBe('DONE');
    expect(await count('bot_updates', `status = 'DONE'`)).toBe(2);

    // hard proof of no overtaking: the reply to message 1 was stored BEFORE
    // message 2's user row even existed
    const [secondUserMsg] = await ds.query(
      `SELECT id FROM messages WHERE role = 'USER' AND content = 'پیام دوم'`,
    );
    const [firstReply] = await ds.query(
      `SELECT id FROM messages WHERE role = 'ASSISTANT' ORDER BY id ASC LIMIT 1`,
    );
    expect(Number(secondUserMsg.id)).toBeGreaterThan(Number(firstReply.id));
  });

  it('BLOCKED RECOVERY (review fix): a fresh message from a blocked user clears the stale flag and is processed', async () => {
    // a previous outbound 403 flagged this user — but they have since unblocked
    // the bot and written again (Telegram only delivers from unblocked chats)
    await ds.query(
      `INSERT INTO telegram_users (telegram_id, chat_id, is_blocked)
       VALUES ('950820', '950820', true)`,
    );

    await postUpdate(messageUpdate(950820, 'سلام دوباره'));
    await assistantSent(1);

    const [user] = await ds.query(
      `SELECT is_blocked FROM telegram_users WHERE telegram_id = '950820'`,
    );
    expect(user.is_blocked).toBe(false); // the stale flag healed
    expect(await count('messages', `role = 'USER'`)).toBe(1);
    expect(await count('tickets')).toBe(1);
    const [update] = await ds.query(`SELECT status FROM bot_updates`);
    expect(update.status).toBe('DONE'); // previously such messages were silently dropped
    expect(fakeGateway.sent.length).toBeGreaterThanOrEqual(1); // the reply reached the chat
  });

  it('CRASH RECOVERY (empty-ticket fix): retrying a stored message NEVER opens a second, empty active ticket', async () => {
    await postUpdate(messageUpdate(950830, 'پیام با کرش در بازبینی'));
    await assistantSent(1);

    // the operator closes the ORIGINAL ticket during the retry window
    const [ticket] = await ds.query(`SELECT id FROM tickets`);
    await authed(
      request(app.getHttpServer()).patch(`/api/tickets/${ticket.id}/status`).send({ status: 'CLOSED' }),
    ).expect(200);

    // simulate the crash: the update sits in stale PROCESSING with its user
    // message already stored (the reply is deleted so the retry has real work)
    await ds.query(`DELETE FROM messages WHERE role = 'ASSISTANT'`);
    await ds.query(
      `UPDATE bot_updates SET status = 'PROCESSING', stage = 'USER_SAVED',
       locked_at = now() - interval '3 minutes'`,
    );

    await app.get(SweeperService).sweep('cron');
    await assistantSent(1);

    // THE assertion: exactly ONE ticket exists — the retry resumed inside the
    // ORIGINAL (closed) ticket instead of creating a fresh, EMPTY active one
    expect(await count('tickets')).toBe(1);
    expect(await count('tickets', `status <> 'CLOSED'`)).toBe(0); // no empty ACTIVE ticket left behind
    expect(await count('messages', `role = 'USER'`)).toBe(1);
    expect(await count('messages', `role = 'ASSISTANT'`)).toBe(1);

    // the regenerated reply landed in the ORIGINAL ticket — next to its user message
    const [reply] = await ds.query(`SELECT ticket_id FROM messages WHERE role = 'ASSISTANT'`);
    expect(reply.ticket_id).toBe(ticket.id);
    const [update] = await ds.query(`SELECT status, stage FROM bot_updates`);
    expect(update.status).toBe('DONE');
    expect(update.stage).toBe('REPLY_SAVED');
  });

  it('CURSOR VALIDATION: out-of-bigint-range and zero cursors are 400s, the bigint max is accepted', async () => {
    const [user] = await ds.query(
      `INSERT INTO telegram_users (telegram_id, chat_id) VALUES ('950411', '950411') RETURNING *`,
    );
    const [ticket] = await ds.query(
      `INSERT INTO tickets (user_id, subject) VALUES ($1, 'کرسور معتبر') RETURNING *`,
      [user.id],
    );
    await ds.query(
      `INSERT INTO messages (ticket_id, role, content) VALUES ($1, 'USER', 'سلام')`,
      [ticket.id],
    );
    const api = `/api/tickets/${ticket.id}/messages`;

    // 19 digits but ABOVE bigint max → 400, not a 500 from the database
    await authed(request(app.getHttpServer()).get(`${api}?before=9999999999999999999`)).expect(400);
    await authed(request(app.getHttpServer()).get(`${api}?after=9999999999999999999`)).expect(400);
    // zero is never a message id cursor
    await authed(request(app.getHttpServer()).get(`${api}?before=0`)).expect(400);
    await authed(request(app.getHttpServer()).get(`${api}?after=0`)).expect(400);
    // the exact bigint boundary is a VALID (empty) page
    await authed(request(app.getHttpServer()).get(`${api}?after=9223372036854775807`)).expect(200);
  });

  it('VALIDATION: /users/:id rejects non-uuid with 400; ticket list embeds the owner', async () => {
    await authed(request(app.getHttpServer()).get('/api/users/not-a-uuid')).expect(400);

    await postUpdate(messageUpdate(950500, 'سلام از کاربر جدید'));
    await assistantSent(1);

    const list = await authed(request(app.getHttpServer()).get('/api/tickets')).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].user).toMatchObject({ telegram_id: '950500' });
    expect(list.body.data[0].user.first_name).toContain('950500');
  });

  it('WEBHOOK #4-c: malformed payloads are rejected 400 BEFORE touching the inbox', async () => {
    const server = app.getHttpServer();
    const post = (body: unknown) =>
      request(server).post('/api/telegram/webhook').set('x-telegram-bot-api-secret-token', webhookSecret).send(body as object);

    expect((await post({ hello: 'world' })).status).toBe(400); // no update_id
    expect((await post({ update_id: 'x', message: {} })).status).toBe(400); // non-numeric id
    expect((await post([1, 2, 3])).status).toBe(400); // not an object
    expect(await count('bot_updates')).toBe(0);
  });

  it('WEBHOOK (review round 5 #3): a message WITHOUT chat is a clean 400 — never an inbox row that fails processing', async () => {
    const server = app.getHttpServer();
    const post = (body: unknown) =>
      request(server).post('/api/telegram/webhook').set('x-telegram-bot-api-secret-token', webhookSecret).send(body as object);

    // valid-looking message but NO chat → the orchestrator would crash on
    // message.chat.id — it must be rejected here instead
    expect(
      (await post({ update_id: nextUpdateId++, message: { message_id: 1, text: 'سلام' } })).status,
    ).toBe(400);
    // chat present but without a type — also rejected
    expect(
      (await post({
        update_id: nextUpdateId++,
        message: { message_id: 2, chat: { id: 111 }, text: 'سلام' },
      })).status,
    ).toBe(400);
    // a proper update STILL passes
    expect((await post(messageUpdate(950750, 'پیام سالم'))).status).toBe(200);

    expect(await count('bot_updates')).toBe(1); // only the healthy one
  });

  it('RETRY BACKOFF (review round 5 #1): a transient failure schedules a real backoff, the sweeper honors it, and the panel can retry manually', async () => {
    const [user] = await ds.query(
      `INSERT INTO telegram_users (telegram_id, chat_id) VALUES ('950800', '950800') RETURNING *`,
    );
    const [ticket] = await ds.query(
      `INSERT INTO tickets (user_id, subject) VALUES ($1, 'بک‌آف') RETURNING *`,
      [user.id],
    );
    const [msg] = await ds.query(
      `INSERT INTO messages (ticket_id, role, content, delivery_status) VALUES ($1, 'ASSISTANT', 'پیام قطع شبکه', 'PENDING') RETURNING *`,
      [ticket.id],
    );

    // simulate a Telegram outage: the send fails transiently
    fakeGateway.failNext = true;
    await app.get(OutboxDispatcherService).deliver(msg);

    const [failed] = await ds.query(
      `SELECT delivery_status, delivery_attempts, next_attempt_at, error FROM messages WHERE id = $1`,
      [msg.id],
    );
    expect(failed.delivery_status).toBe('FAILED');
    expect(Number(failed.delivery_attempts)).toBe(1); // consumed at claim time
    expect(failed.error).toContain('simulated telegram failure');
    // THE FIX: the next attempt is SCHEDULED ~20 s out — the old code left it
    // NULL and the 15 s sweeper burned all 5 attempts within a minute
    expect(new Date(failed.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 10_000);
    expect(fakeGateway.sent).toHaveLength(0);

    // the sweeper scan SKIPS the scheduled row...
    const due = await app.get(MessagesService).findDueOutbox(50);
    expect(due.find((m: { id: string }) => m.id === msg.id)).toBeUndefined();
    // ...and a fresh claim cannot steal it either
    expect(await app.get(MessagesService).claimForDelivery(msg.id)).toBeNull();

    // the operator retries from the panel → re-armed and delivered NOW
    const res = await authed(
      request(app.getHttpServer())
        .post(`/api/tickets/${ticket.id}/messages/${msg.id}/retry`)
        .send({}),
    ).expect(200);
    expect(res.body.data.delivery_status).toBe('PENDING');
    expect(Number(res.body.data.delivery_attempts)).toBe(0);

    await waitFor(async () => {
      const [r] = await ds.query(`SELECT delivery_status FROM messages WHERE id = $1`, [msg.id]);
      return r.delivery_status === 'SENT';
    });
    expect(fakeGateway.sent.filter((s) => s.text === 'پیام قطع شبکه')).toHaveLength(1);

    // retrying a SENT message is a 409; a foreign message id is a 404
    await authed(
      request(app.getHttpServer())
        .post(`/api/tickets/${ticket.id}/messages/${msg.id}/retry`)
        .send({}),
    ).expect(409);
    await authed(
      request(app.getHttpServer())
        .post(`/api/tickets/${ticket.id}/messages/999999/retry`)
        .send({}),
    ).expect(404);
  });

  it('BLOCKED RACE (review round 5 #4): a late 403 can NOT re-block a user whose newer message already arrived', async () => {
    const [user] = await ds.query(
      `INSERT INTO telegram_users (telegram_id, chat_id) VALUES ('950810', '950810') RETURNING *`,
    );
    const [ticket] = await ds.query(
      `INSERT INTO tickets (user_id, subject) VALUES ($1, 'مسابقه وضعیت') RETURNING *`,
      [user.id],
    );
    const [msg] = await ds.query(
      `INSERT INTO messages (ticket_id, role, content, delivery_status) VALUES ($1, 'ASSISTANT', 'ارسال قدیمی', 'PENDING') RETURNING *`,
      [ticket.id],
    );

    // the RACE: after this old send was claimed, the user unblocked the bot and
    // sent a fresh message — its processing bumped last_seen_at PAST the claim
    await ds.query(`UPDATE telegram_users SET last_seen_at = now() + interval '2 seconds' WHERE id = $1`, [user.id]);
    fakeGateway.failNextWith(new TelegramApiError('Forbidden: bot was blocked by the user', 403, true));

    await app.get(OutboxDispatcherService).deliver(msg);

    // the stale 403 must NOT overwrite the newer unblocked state...
    const [after] = await ds.query(`SELECT is_blocked FROM telegram_users WHERE id = $1`, [user.id]);
    expect(after.is_blocked).toBe(false);
    // ...but the message itself is still terminal (403s never retry)
    const [m] = await ds.query(
      `SELECT delivery_status, delivery_attempts FROM messages WHERE id = $1`,
      [msg.id],
    );
    expect(m.delivery_status).toBe('FAILED');
    expect(Number(m.delivery_attempts)).toBe(5);
  });

  it('BLOCKED (no newer activity): a 403 without any newer incoming message still flags the user', async () => {
    const [user] = await ds.query(
      `INSERT INTO telegram_users (telegram_id, chat_id) VALUES ('950820', '950820') RETURNING *`,
    );
    const [ticket] = await ds.query(
      `INSERT INTO tickets (user_id, subject) VALUES ($1, 'کاربر رفته') RETURNING *`,
      [user.id],
    );
    const [msg] = await ds.query(
      `INSERT INTO messages (ticket_id, role, content, delivery_status) VALUES ($1, 'ASSISTANT', 'ارسال به رفته‌ها', 'PENDING') RETURNING *`,
      [ticket.id],
    );

    // NO new activity since the message was processed — the 403 is the newest reality
    await ds.query(`UPDATE telegram_users SET last_seen_at = now() - interval '5 seconds' WHERE id = $1`, [user.id]);
    fakeGateway.failNextWith(new TelegramApiError('Forbidden: bot was blocked by the user', 403, true));

    await app.get(OutboxDispatcherService).deliver(msg);

    const [after] = await ds.query(`SELECT is_blocked FROM telegram_users WHERE id = $1`, [user.id]);
    expect(after.is_blocked).toBe(true); // the guard lets the honest flag through
  });

  it('RETENTION: old inbox rows are purged; conversation history is untouched', async () => {
    await postUpdate(messageUpdate(950600, 'پیام برای نگهداری'));
    await assistantSent(1);
    expect(await count('bot_updates')).toBe(1);

    // age the raw payload beyond the 30-day default
    await ds.query(`UPDATE bot_updates SET received_at = now() - interval '40 days'`);

    const removed = await app.get(InboxRetentionService).run('cron');
    expect(removed).toBe(1);
    expect(await count('bot_updates')).toBe(0);
    expect(await count('messages')).toBeGreaterThanOrEqual(3); // history intact
  });

  it('WEBSOCKET: user:new + ticket:updated still arrive after commit (events-after-commit fix)', async () => {
    const url = await app.getUrl();
    const socket = socketIoClient(url, { auth: { token }, transports: ['websocket'] });

    const nextEvent = (event: string, timeoutMs = 5000): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
        socket.once(event, (payload: Record<string, unknown>) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', (err: Error) => reject(err));
      });

      // first message from a brand-new user → user:new
      const userEvent = nextEvent('user:new');
      await postUpdate(messageUpdate(950700, 'پیام وب‌سوکت'));
      await expect(userEvent).resolves.toMatchObject({
        user: { telegram_id: '950700' },
      });
      await assistantSent(1);

      // admin status change → ticket:updated + message:new (system notification)
      const [t] = await ds.query(`SELECT id FROM tickets`);
      const ticketEvent = nextEvent('ticket:updated');
      await authed(
        request(app.getHttpServer()).patch(`/api/tickets/${t.id}/status`).send({ status: 'CLOSED' }),
      ).expect(200);
      await expect(ticketEvent).resolves.toMatchObject({
        ticket: { id: t.id, status: 'CLOSED' },
      });
    } finally {
      socket.close();
    }
  });
});
