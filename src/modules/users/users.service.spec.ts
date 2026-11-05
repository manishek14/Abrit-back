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
});
