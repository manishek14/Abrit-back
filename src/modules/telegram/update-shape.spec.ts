import { isValidUpdateShape } from './update-shape';

describe('isValidUpdateShape (webhook input validation — review fix #4-c)', () => {
  const validUpdate = (over: Record<string, unknown> = {}) => ({
    update_id: 100,
    message: {
      message_id: 1,
      from: { id: 111, is_bot: false },
      chat: { id: 111, type: 'private' },
      text: 'سلام',
    },
    ...over,
  });

  it('accepts a normal private-chat text update', () => {
    expect(isValidUpdateShape(validUpdate())).toBe(true);
  });

  it('accepts valid-but-ignored shapes (edited_message, channel_post) — the orchestrator decides', () => {
    expect(isValidUpdateShape({ update_id: 101, edited_message: { message_id: 1 } })).toBe(true);
    expect(isValidUpdateShape({ update_id: 102, channel_post: { message_id: 2 } })).toBe(true);
  });

  it.each([
    ['not an object', 'garbage'],
    ['an array', [1, 2, 3]],
    ['null', null],
    ['missing update_id', { message: { message_id: 1 } }],
    ['non-numeric update_id', { update_id: '100' }],
    ['fractional update_id', { update_id: 1.5 }],
    ['negative update_id', { update_id: -1 }],
    ['update_id beyond bigint', { update_id: 9_9e18 }],
    ['message not an object', { update_id: 1, message: 'nope' }],
    ['message without message_id', { update_id: 1, message: { chat: { id: 1 } } }],
    ['chat without id', { update_id: 1, message: { message_id: 1, chat: { type: 'private' } } }],
    ['from not an object', { update_id: 1, message: { message_id: 1, from: 'x' } }],
    ['non-string text', { update_id: 1, message: { message_id: 1, text: 42 } }],
  ])('rejects %s', (_label, payload) => {
    expect(isValidUpdateShape(payload)).toBe(false);
  });

  it('rejects oversized payloads (jsonb sanity limit)', () => {
    const huge = validUpdate();
    (huge.message as Record<string, unknown>).text = 'x'.repeat(70_000);
    expect(isValidUpdateShape(huge)).toBe(false);
  });
});
