import { Repository } from 'typeorm';
import { UsersService } from './users.service';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { EventsService } from '../../common/events/events.service';

describe('UsersService', () => {
  let service: UsersService;
  let repo: { query: jest.Mock; findOneBy: jest.Mock; update: jest.Mock };
  let events: { emit: jest.Mock };

  beforeEach(() => {
    repo = { query: jest.fn(), findOneBy: jest.fn(), update: jest.fn() };
    events = { emit: jest.fn() };
    service = new UsersService(
      repo as unknown as Repository<TelegramUser>,
      events as unknown as EventsService,
    );
  });

  it('upserts a user with chat_id defaulting to telegram_id', async () => {
    const row = { id: 'u-1', telegram_id: '111', chat_id: '111' };
    repo.query.mockResolvedValueOnce([row]);

    const user = await service.upsertTelegramUser({ telegram_id: '111', username: 'sara' });

    expect(repo.query).toHaveBeenCalledTimes(1);
    const params = repo.query.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe('111');
    expect(params[1]).toBe('111'); // chat_id default = telegram_id (private chat)
    expect(user).toBe(row);
  });

  it('emits user.created ONLY for a first-seen user (_was_inserted = true)', async () => {
    repo.query.mockResolvedValueOnce([{ id: 'u-new', _was_inserted: true }]);
    await service.upsertTelegramUser({ telegram_id: '333' });
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      'user.created',
      expect.objectContaining({ user: expect.objectContaining({ id: 'u-new' }) }),
    );
  });

  it('does not emit for an existing user profile refresh (_was_inserted = false)', async () => {
    repo.query.mockResolvedValueOnce([{ id: 'u-known', _was_inserted: false }]);
    await service.upsertTelegramUser({ telegram_id: '333' });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('keeps an explicitly provided chat_id independent from telegram_id', async () => {
    repo.query.mockResolvedValueOnce([{ id: 'u-2' }]);
    await service.upsertTelegramUser({ telegram_id: '111', chat_id: '-100999' });
    expect((repo.query.mock.calls[0][1] as unknown[])[1]).toBe('-100999');
  });

  it('passes profile fields through as nullable parameters', async () => {
    repo.query.mockResolvedValueOnce([{ id: 'u-3' }]);
    await service.upsertTelegramUser({
      telegram_id: '222',
      first_name: 'سارا',
      last_name: 'محمدی',
      language_code: 'fa',
    });
    const params = repo.query.mock.calls[0][1] as unknown[];
    expect(params[3]).toBe('سارا');
    expect(params[4]).toBe('محمدی');
    expect(params[5]).toBe('fa');
  });

  it('finds a user by telegram_id', async () => {
    repo.findOneBy.mockResolvedValueOnce({ id: 'u-1' } as TelegramUser);
    const found = await service.findByTelegramId('111');
    expect(repo.findOneBy).toHaveBeenCalledWith({ telegram_id: '111' });
    expect(found?.id).toBe('u-1');
  });

  describe('setBlockedIfNoNewerActivity (review round 5 fix #4 — blocked-status race)', () => {
    it('atomically guards the flag on last_seen_at < cutoff and reports the outcome', async () => {
      repo.query.mockResolvedValueOnce([{ id: 'u-1' }]);
      const cutoff = new Date('2026-01-01T10:00:00Z');

      const flagged = await service.setBlockedIfNoNewerActivity('u-1', cutoff);

      expect(flagged).toBe(true);
      const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('SET is_blocked = true');
      // THE GUARD: the write only lands when NO newer incoming message exists —
      // a late 403 from an old in-flight send can never overwrite the newer
      // unblocked state of a user who already messaged the bot again.
      expect(sql).toContain('last_seen_at < $2::timestamptz');
      expect(params).toEqual(['u-1', cutoff.toISOString()]);
    });

    it('reports FALSE when a newer message exists (0 rows updated) — the user stays unblocked', async () => {
      repo.query.mockResolvedValueOnce([]);
      expect(await service.setBlockedIfNoNewerActivity('u-1', new Date())).toBe(false);
    });
  });
});

describe('UsersService — profile & state (feature round)', () => {
  let service: UsersService;
  let repo: { query: jest.Mock; findOneBy: jest.Mock; update: jest.Mock };
  let events: { emit: jest.Mock };

  beforeEach(() => {
    repo = { query: jest.fn(), findOneBy: jest.fn(), update: jest.fn() };
    events = { emit: jest.fn() };
    service = new UsersService(
      repo as unknown as Repository<TelegramUser>,
      events as unknown as EventsService,
    );
  });

  it('completeProfile writes name + phone + the completion timestamp in ONE update', async () => {
    const updated = { id: 'u-1', full_name: 'علی رضایی', phone: '09123456789' };
    repo.update.mockResolvedValueOnce({});
    repo.findOneBy.mockResolvedValueOnce(updated as TelegramUser);

    const out = await service.completeProfile('u-1', {
      full_name: 'علی رضایی',
      phone: '09123456789',
    });

    expect(repo.update).toHaveBeenCalledWith(
      { id: 'u-1' },
      expect.objectContaining({ full_name: 'علی رضایی', phone: '09123456789' }),
    );
    const patch = repo.update.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.profile_completed_at).toBeInstanceOf(Date);
    expect(out).toBe(updated);
  });

  it('isProfileComplete requires the timestamp AND both fields (a half profile is NOT complete)', () => {
    const base = { id: 'u-1' } as TelegramUser;
    expect(service.isProfileComplete(base)).toBe(false);
    expect(
      service.isProfileComplete({ ...base, profile_completed_at: new Date() } as TelegramUser),
    ).toBe(false);
    expect(
      service.isProfileComplete({
        ...base,
        profile_completed_at: new Date(),
        full_name: 'علی',
        phone: '09123456789',
      } as TelegramUser),
    ).toBe(true);
    expect(
      service.isProfileComplete({
        ...base,
        profile_completed_at: new Date(),
        full_name: 'علی رضایی',
      } as TelegramUser),
    ).toBe(false); // phone missing
    expect(
      service.isProfileComplete({
        ...base,
        profile_completed_at: new Date(),
        full_name: 'علی رضایی',
        phone: '09123456789',
      } as TelegramUser),
    ).toBe(true);
  });

  it('setBotState persists the jsonb and clear passes null', async () => {
    repo.update.mockResolvedValue({});
    const state = { flow: 'TICKET_TITLE', data: {}, updated_at: new Date().toISOString() };

    await service.setBotState('u-1', state as never);
    expect(repo.update).toHaveBeenCalledWith({ id: 'u-1' }, { bot_state: state });

    await service.setBotState('u-1', null);
    expect(repo.update).toHaveBeenLastCalledWith({ id: 'u-1' }, { bot_state: null });
  });

  it('upsertTelegramUser does NOT touch profile/state columns (registration data survives refreshes)', async () => {
    repo.query.mockResolvedValue([{ id: 'u-1', _was_inserted: false }]);
    await service.upsertTelegramUser({ telegram_id: '111', username: 'sara' });
    const sql = repo.query.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/full_name|bot_state|profile_completed_at/);
  });
});
