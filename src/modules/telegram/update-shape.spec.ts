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

  describe('review round 5 fix #3 — chat is REQUIRED whenever a message exists', () => {
    it('rejects a message WITHOUT chat entirely (previously entered the inbox and failed processing)', () => {
      expect(
        isValidUpdateShape({ update_id: 110, message: { message_id: 1, text: 'سلام' } }),
      ).toBe(false);
    });

    it('rejects a chat that is not an object', () => {
      expect(
        isValidUpdateShape({ update_id: 111, message: { message_id: 1, chat: 'x' } }),
      ).toBe(false);
    });

    it('rejects a chat with a non-scalar id', () => {
      expect(
        isValidUpdateShape({ update_id: 112, message: { message_id: 1, chat: { id: { x: 1 }, type: 'private' } } }),
      ).toBe(false);
    });

    it('rejects a chat without a type (the orchestrator relies on it for the private-chat filter)', () => {
      expect(
        isValidUpdateShape({ update_id: 113, message: { message_id: 1, chat: { id: 111 } } }),
      ).toBe(false);
    });

    it('accepts a STRING chat id (Telegram uses strings for some chat kinds)', () => {
      expect(
        isValidUpdateShape({
          update_id: 114,
          message: { message_id: 1, chat: { id: '111', type: 'private' }, text: 'سلام' },
        }),
      ).toBe(true);
    });

    it('still accepts valid-but-ignored shapes without a message (edited_message etc.)', () => {
      expect(isValidUpdateShape({ update_id: 115, edited_message: { message_id: 1 } })).toBe(true);
    });
  });

  it('rejects oversized payloads (jsonb sanity limit)', () => {
    const huge = validUpdate();
    (huge.message as Record<string, unknown>).text = 'x'.repeat(70_000);
    expect(isValidUpdateShape(huge)).toBe(false);
  });
});
