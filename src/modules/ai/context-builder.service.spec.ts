import { ContextBuilderService } from './context-builder.service';
import { MessagesService } from '../messages/messages.service';
import { Message } from '../../database/entities/message.entity';
import { MessageRole } from '../../database/enums';
import { setTestEnv } from '../../common/testing/test-env';

setTestEnv();

const mk = (id: string, role: MessageRole, content: string, ticket_id = 't-1'): Message =>
  ({ id, role, content, ticket_id }) as Message;

describe('ContextBuilderService', () => {
  let messages: { getRecentConversation: jest.Mock };
  let service: ContextBuilderService;

  beforeEach(() => {
    setTestEnv();
    messages = { getRecentConversation: jest.fn() };
    service = new ContextBuilderService(messages as unknown as MessagesService);
  });

  it('maps roles, drops SYSTEM messages and merges consecutive same-role turns', async () => {
    messages.getRecentConversation.mockResolvedValueOnce([
      mk('1', MessageRole.USER, 'سلام'),
      mk('2', MessageRole.ASSISTANT, 'پاسخ اول'),
      mk('3', MessageRole.SYSTEM, 'اعلان سیستمی'),
      mk('4', MessageRole.ADMIN, 'پاسخ ادمین'),
      mk('5', MessageRole.USER, 'ادامه بحث'),
    ]);

    const res = await service.build('t-1', 'SYSTEM PROMPT');

    expect(res.messages).toEqual([
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'سلام' },
      { role: 'assistant', content: 'پاسخ اول\nپاسخ ادمین' },
      { role: 'user', content: 'ادامه بحث' },
    ]);
    expect(res.truncated).toBe(false);
  });

  it('asks for exactly the last N messages of THE ticket', async () => {
    messages.getRecentConversation.mockResolvedValueOnce([]);
    await service.build('t-9', 'p');
    expect(messages.getRecentConversation).toHaveBeenCalledWith('t-9', 20);
  });

  it('trims the oldest turns by character budget but never the last user message', async () => {
    setTestEnv({ AI_CONTEXT_MAX_CHARS: '2050' }); // budget = 2050 - 1 (prompt 'p') = 2049
    service = new ContextBuilderService(messages as unknown as MessagesService);
    messages.getRecentConversation.mockResolvedValueOnce([
      mk('1', MessageRole.USER, 'x'.repeat(1900)), // oldest → dropped
      mk('2', MessageRole.ASSISTANT, 'y'.repeat(900)),
      mk('3', MessageRole.USER, 'پیام آخر کاربر'), // always kept
    ]);

    const res = await service.build('t-1', 'p');

    expect(res.truncated).toBe(true);
    expect(res.messages).toEqual([
      { role: 'system', content: 'p' },
      { role: 'assistant', content: 'y'.repeat(900) },
      { role: 'user', content: 'پیام آخر کاربر' },
    ]);
  });

  it('never mixes tickets: ticket A text never enters ticket B payload (isolation by design)', async () => {
    messages.getRecentConversation.mockImplementation(async (ticketId: string) =>
      ticketId === 't-A'
        ? [mk('1', MessageRole.USER, 'متن محرمانه تیکت A', 't-A')]
        : [mk('9', MessageRole.USER, 'متن محرمانه تیکت B', 't-B')],
    );

    const a = await service.build('t-A', 'prompt');
    const b = await service.build('t-B', 'prompt');

    expect(JSON.stringify(a.messages)).toContain('متن محرمانه تیکت A');
    expect(JSON.stringify(a.messages)).not.toContain('تیکت B');

    expect(JSON.stringify(b.messages)).toContain('متن محرمانه تیکت B');
    expect(JSON.stringify(b.messages)).not.toContain('تیکت A');
  });
});
