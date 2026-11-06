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

describe('isValidUpdateShape — callback queries & contacts (feature round)', () => {
  const validCallback = (over: Record<string, unknown> = {}) => ({
    update_id: 200,
    callback_query: {
      id: 'cb-1',
      from: { id: 111, is_bot: false, first_name: 'سارا' },
      message: { message_id: 5, chat: { id: 111, type: 'private' } },
      data: 'myt:page:2',
    },
    ...over,
  });

  it('accepts a valid callback query (my-tickets pagination)', () => {
    expect(isValidUpdateShape(validCallback())).toBe(true);
  });

  it('accepts a callback without the embedded message / data (defensive shapes)', () => {
    expect(
      isValidUpdateShape({
        update_id: 201,
        callback_query: { id: 'cb-2', from: { id: 111 }, data: 'myt:noop' },
      }),
    ).toBe(true);
  });

  it.each([
    ['missing id', { update_id: 202, callback_query: { from: { id: 111 } } }],
    ['empty id', { update_id: 203, callback_query: { id: '', from: { id: 111 } } }],
    ['non-string id', { update_id: 204, callback_query: { id: 5, from: { id: 111 } } }],
    ['missing from', { update_id: 205, callback_query: { id: 'cb' } }],
    ['bad embedded chat', { update_id: 206, callback_query: { id: 'cb', from: { id: 1 }, message: { chat: { type: 'private' } } } }],
    ['non-string data', { update_id: 207, callback_query: { id: 'cb', from: { id: 1 }, data: 5 } }],
  ])('rejects a callback with %s', (_name, update) => {
    expect(isValidUpdateShape(update)).toBe(false);
  });

  it('accepts a contact message (registration request_contact button)', () => {
    expect(
      isValidUpdateShape({
        update_id: 210,
        message: {
          message_id: 1,
          from: { id: 111 },
          chat: { id: 111, type: 'private' },
          contact: { phone_number: '+989123456789', user_id: 111 },
        },
      }),
    ).toBe(true);
  });

  it('rejects malformed contact payloads', () => {
    expect(
      isValidUpdateShape({
        update_id: 211,
        message: {
          message_id: 1,
          chat: { id: 111, type: 'private' },
          contact: '09123456789',
        },
      }),
    ).toBe(false);
    expect(
      isValidUpdateShape({
        update_id: 212,
        message: {
          message_id: 1,
          chat: { id: 111, type: 'private' },
          contact: { phone_number: 123 },
        },
      }),
    ).toBe(false);
  });
});
