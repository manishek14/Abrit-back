import { BotStateService, BOT_STATE_TTL_MS } from './bot-state.service';
import { UsersService } from '../users/users.service';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { parseBotState } from './bot-state.types';

const mkUser = (bot_state: unknown = null): TelegramUser =>
  ({ id: 'u-1', bot_state }) as TelegramUser;

describe('BotStateService (feature — session/state machine)', () => {
  let service: BotStateService;
  let users: { setBotState: jest.Mock; findByIdOrNull: jest.Mock };

  beforeEach(() => {
    users = {
      setBotState: jest.fn().mockResolvedValue(undefined),
      findByIdOrNull: jest.fn(),
    };
    service = new BotStateService(users as unknown as UsersService);
  });

  it('set writes the flow + data + timestamp onto the user row', async () => {
    await service.set('u-1', 'TICKET_TITLE', { title: 'سلام' });
    expect(users.setBotState).toHaveBeenCalledWith('u-1', expect.any(Object));
    const written = users.setBotState.mock.calls[0][1];
    expect(written.flow).toBe('TICKET_TITLE');
    expect(written.data).toEqual({ title: 'سلام' });
    expect(new Date(written.updated_at).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('clear writes null (the state row disappears)', async () => {
    await service.clear('u-1');
    expect(users.setBotState).toHaveBeenCalledWith('u-1', null);
  });

  it('returns null for absent/corrupt state (re-reads the DB row, never the stale entity)', async () => {
    users.findByIdOrNull.mockResolvedValue({ id: 'u-1', bot_state: null });
    expect(await service.get(mkUser({ flow: 'TICKET_TITLE' }))).toBeNull(); // the PASSED entity is ignored
    users.findByIdOrNull.mockResolvedValue({ id: 'u-1', bot_state: 'garbage' });
    expect(await service.get(mkUser())).toBeNull();
    users.findByIdOrNull.mockResolvedValue({ id: 'u-1', bot_state: { flow: 'NOT_A_FLOW' } });
    expect(await service.get(mkUser())).toBeNull();
    expect(users.setBotState).not.toHaveBeenCalled();
  });

  it('EXPIRES state older than the TTL and clears it (§8: no stale state)', async () => {
    const stale = parseBotState({
      flow: 'TICKET_TITLE',
      data: {},
      updated_at: new Date(Date.now() - BOT_STATE_TTL_MS - 1000).toISOString(),
    });
    users.findByIdOrNull.mockResolvedValue({ id: 'u-1', bot_state: stale });
    expect(await service.get(mkUser())).toBeNull();
    expect(users.setBotState).toHaveBeenCalledWith('u-1', null); // cleaned up
  });

  it('keeps fresh state alive (read from the DB row)', async () => {
    const fresh = parseBotState({
      flow: 'REGISTER_PHONE',
      data: { name: 'علی رضایی' },
      updated_at: new Date().toISOString(),
    });
    users.findByIdOrNull.mockResolvedValue({ id: 'u-1', bot_state: fresh });
    const out = await service.get(mkUser({ bot_state: null })); // entity has NOTHING — DB is the truth
    expect(out?.flow).toBe('REGISTER_PHONE');
    expect(out?.data?.name).toBe('علی رضایی');
    expect(users.setBotState).not.toHaveBeenCalled();
  });

  it('withChatTurn appends compact entries and caps the history at 8', () => {
    const prev = parseBotState({
      flow: 'CHAT',
      data: { history: [{ r: 'u', c: 'q' }, { r: 'a', c: 'r' }] },
      updated_at: new Date().toISOString(),
    });
    const next = service.withChatTurn(prev, 'سؤال جدید', 'پاسخ جدید');
    expect(next.flow).toBe('CHAT');
    expect(next.data?.history).toEqual([
      { r: 'u', c: 'q' },
      { r: 'a', c: 'r' },
      { r: 'u', c: 'سؤال جدید' },
      { r: 'a', c: 'پاسخ جدید' },
    ]);

    const longHistory = Array.from({ length: 10 }, (_, i) => ({
      r: 'u' as const,
      c: `m${i}`,
    }));
    const capped = service.withChatTurn(
      parseBotState({ flow: 'CHAT', data: { history: longHistory }, updated_at: new Date().toISOString() }),
      'x',
      'y',
    );
    expect(capped.data?.history).toHaveLength(8);
  });

  it('withChatTurn ignores history from OTHER flows (no cross-flow leakage)', () => {
    const ticketState = parseBotState({
      flow: 'TICKET_TITLE',
      data: { title: 'x' },
      updated_at: new Date().toISOString(),
    });
    const next = service.withChatTurn(ticketState, 'سلام', 'جواب');
    expect(next.data?.history).toEqual([
      { r: 'u', c: 'سلام' },
      { r: 'a', c: 'جواب' },
    ]);
  });
});
