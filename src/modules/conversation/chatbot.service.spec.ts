import { ChatbotService, splitForTelegram } from './chatbot.service';
import { UsersService } from '../users/users.service';
import { TicketsService } from '../tickets/tickets.service';
import { BotStateService } from './bot-state.service';
import { GeneralChatService } from '../ai/general-chat.service';
import { TelegramGateway } from '../telegram/telegram-gateway.interface';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { TicketDepartment, TicketStatus } from '../../database/enums';
import { Ticket } from '../../database/entities/ticket.entity';
import { chatbotKeyboard, mainMenuKeyboard } from '../telegram/keyboards';
import {
  CHATBOT_ERROR,
  CHATBOT_INTRO,
  CHATBOT_LEFT,
  CHATBOT_WAITING,
  TELEGRAM_MESSAGE_MAX_CHARS,
} from '../../common/bot-messages';

const mkUser = (over: Partial<TelegramUser> = {}): TelegramUser =>
  ({
    id: 'u-1',
    telegram_id: '700100200',
    chat_id: '555',
    profile_completed_at: new Date(),
    full_name: 'علی رضایی',
    phone: '09123456789',
    ...over,
  }) as TelegramUser;

const mkTicket = (): Ticket =>
  ({
    id: 't-1',
    ticket_number: 'TKT-10001',
    user_id: 'u-1',
    status: TicketStatus.OPEN,
    subject: 'مشکل پرداخت',
    department: TicketDepartment.FINANCE,
  }) as Ticket;

describe('ChatbotService (request §4/§5)', () => {
  let service: ChatbotService;
  let users: { setBotState: jest.Mock };
  let tickets: { findActiveTicket: jest.Mock };
  let botState: { get: jest.Mock; set: jest.Mock; clear: jest.Mock; withChatTurn: jest.Mock };
  let generalChat: { reply: jest.Mock };
  let gateway: {
    active: boolean;
    sendMessage: jest.Mock;
    editMessageText: jest.Mock;
  };

  beforeEach(() => {
    users = { setBotState: jest.fn().mockResolvedValue(undefined) };
    tickets = { findActiveTicket: jest.fn().mockResolvedValue(null) };
    botState = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
      withChatTurn: jest.fn().mockReturnValue({ flow: 'CHAT', data: { history: [] } }),
    };
    generalChat = {
      reply: jest.fn().mockResolvedValue({
        content: 'پاسخ هوشمند',
        meta: { provider: 'openrouter', model: 'test-model' },
      }),
    };
    gateway = {
      active: true,
      sendMessage: jest.fn().mockResolvedValue({ message_id: '777' }),
      editMessageText: jest.fn().mockResolvedValue(undefined),
    };
    service = new ChatbotService(
      users as unknown as UsersService,
      tickets as unknown as TicketsService,
      botState as unknown as BotStateService,
      generalChat as unknown as GeneralChatService,
      gateway as unknown as TelegramGateway,
    );
  });

  describe('enter', () => {
    it('sets the CHAT state, sends the intro + the chatbot-only keyboard', async () => {
      await service.enter(mkUser(), '555');
      expect(botState.set).toHaveBeenCalledWith('u-1', 'CHAT', { history: [] });
      expect(gateway.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: CHATBOT_INTRO, reply_markup: chatbotKeyboard() }),
      );
    });

    it('re-entering keeps the existing history (no wipe)', async () => {
      botState.get.mockResolvedValue({ flow: 'CHAT', data: { history: [{ r: 'u', c: 'q' }] } });
      await service.enter(mkUser(), '555');
      expect(botState.set).toHaveBeenCalledWith('u-1', 'CHAT', {
        history: [{ r: 'u', c: 'q' }],
      });
    });
  });

  describe('handleText (CHAT state owner)', () => {
    it('returns false when the user is not in chat mode', async () => {
      botState.get.mockResolvedValue(null);
      expect(await service.handleText(mkUser(), '555', 'سلام', 'u1')).toBe(false);
    });

    it('exit button → clears the state + main menu keyboard (§4.6/4.7)', async () => {
      botState.get.mockResolvedValue({ flow: 'CHAT', data: { history: [] } });
      expect(
        await service.handleText(mkUser(), '555', '🔙 بازگشت به منوی اصلی', 'u1'),
      ).toBe(true);
      expect(botState.clear).toHaveBeenCalledWith('u-1');
      expect(gateway.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ reply_markup: mainMenuKeyboard() }),
      );
      expect(generalChat.reply).not.toHaveBeenCalled();
    });

    it('any other text in chat mode goes to the AI turn (§4.5)', async () => {
      botState.get.mockResolvedValue({ flow: 'CHAT', data: { history: [] } });
      await service.handleText(mkUser(), '555', 'سلام ربات', 'u1');
      expect(generalChat.reply).toHaveBeenCalled();
    });
  });

  describe('runTurn — the §5 pipeline', () => {
    it('waiting message is sent BEFORE the provider call, answer EDITS it in place', async () => {
      const order: string[] = [];
      gateway.sendMessage.mockImplementation(async (p: { text: string }) => {
        order.push(`send:${p.text}`);
        return { message_id: '777' };
      });
      generalChat.reply.mockImplementation(async () => {
        order.push('provider');
        return { content: 'پاسخ', meta: { provider: 'openrouter' } };
      });
      gateway.editMessageText.mockImplementation(async (p: { text: string }) => {
        order.push(`edit:${p.text}`);
      });

      await service.runTurn(mkUser(), '555', 'سؤال', 'u1');
      expect(order).toEqual(['send:' + CHATBOT_WAITING, 'provider', 'edit:پاسخ']);
      expect(gateway.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ text: 'پاسخ' }),
      );
    });

    it('history is persisted ONLY on a real provider answer', async () => {
      await service.runTurn(mkUser(), '555', 'سؤال', 'u1');
      expect(botState.withChatTurn).toHaveBeenCalledWith(null, 'سؤال', 'پاسخ هوشمند');
      expect(users.setBotState).toHaveBeenCalled();
    });

    it('provider fallback → understandable CHATBOT_ERROR, history untouched, retry possible', async () => {
      generalChat.reply.mockResolvedValue({
        content: 'پیام شما ثبت شد…',
        meta: { provider: 'fixed', fallback: true, reason: 'timeout' },
      });
      await service.runTurn(mkUser(), '555', 'سؤال', 'u1');
      expect(botState.withChatTurn).not.toHaveBeenCalled();
      expect(users.setBotState).not.toHaveBeenCalled();
      expect(gateway.editMessageText).toHaveBeenCalledWith(
        expect.objectContaining({ message_id: '777', text: CHATBOT_ERROR }),
      );
    });

    it('provider exception → CHATBOT_ERROR (turn completes, nothing thrown)', async () => {
      generalChat.reply.mockRejectedValue(new Error('db down'));
      await expect(service.runTurn(mkUser(), '555', 'سؤال', 'u1')).resolves.toBeUndefined();
      expect(gateway.editMessageText).toHaveBeenCalledWith(
        expect.objectContaining({ text: CHATBOT_ERROR }),
      );
    });

    it('edit failure → the answer is sent as a FRESH message (graceful fallback)', async () => {
      gateway.editMessageText.mockRejectedValue(new Error('edit exploded'));
      await service.runTurn(mkUser(), '555', 'سؤال', 'u1');
      expect(gateway.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'پاسخ هوشمند' }),
      );
    });

    it('answers longer than the Telegram limit travel as several messages', async () => {
      const long = 'الف '.repeat(1500); // ~6000 chars
      generalChat.reply.mockResolvedValue({ content: long, meta: { provider: 'openrouter' } });
      await service.runTurn(mkUser(), '555', 'سؤال', 'u1');
      expect(long.length).toBeGreaterThan(TELEGRAM_MESSAGE_MAX_CHARS);
      const edited = gateway.editMessageText.mock.calls[0][0].text as string;
      expect(edited.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
      // the remainder arrives as follow-up ephemeral sends
      const followUps = gateway.sendMessage.mock.calls.filter(
        (c) => c[0].text !== CHATBOT_WAITING,
      );
      expect(followUps.length).toBeGreaterThanOrEqual(1);
      expect(edited + followUps.map((c) => c[0].text).join('')).toContain('الف');
    });

    it('the SAME update never calls the provider twice (sweeper re-drive, §5)', async () => {
      await service.runTurn(mkUser(), '555', 'سؤال', 'u1');
      await service.runTurn(mkUser(), '555', 'سؤال', 'u1');
      expect(generalChat.reply).toHaveBeenCalledTimes(1);
    });

    it('a durable CHAT state marker (last_update_id) also blocks a duplicate call', async () => {
      botState.get.mockResolvedValue({
        flow: 'CHAT',
        data: { history: [], last_update_id: 'u9' },
      });
      await service.runTurn(mkUser(), '555', 'سؤال', 'u9');
      expect(generalChat.reply).not.toHaveBeenCalled();
    });

    it('chat mode persists the dedup marker BEFORE the provider call', async () => {
      const chatState = { flow: 'CHAT', data: { history: [{ r: 'u', c: 'q' }] } };
      botState.get.mockResolvedValue(chatState);
      let markerSeenDuringCall: unknown = 'not-set';
      generalChat.reply.mockImplementation(async () => {
        markerSeenDuringCall = botState.set.mock.calls.at(-1);
        return { content: 'پاسخ', meta: { provider: 'openrouter' } };
      });
      await service.runTurn(mkUser(), '555', 'سؤال', 'u5');
      expect(botState.set).toHaveBeenCalledWith('u-1', 'CHAT', {
        history: [{ r: 'u', c: 'q' }],
        last_update_id: 'u5',
      });
      expect(markerSeenDuringCall).toEqual(['u-1', 'CHAT', { history: [{ r: 'u', c: 'q' }], last_update_id: 'u5' }]);
    });

    it('per-user isolation: two users get their own state writes', async () => {
      const a = mkUser({ id: 'u-a', chat_id: '1', telegram_id: '1' });
      const b = mkUser({ id: 'u-b', chat_id: '2', telegram_id: '2' });
      botState.get.mockResolvedValue(null);
      await service.runTurn(a, '1', 'سؤال الف', 'ua');
      await service.runTurn(b, '2', 'سؤال ب', 'ub');
      const writes = users.setBotState.mock.calls.map((c) => c[0]);
      expect(writes).toEqual(['u-a', 'u-b']);
    });
  });

  describe('splitForTelegram', () => {
    it('keeps short texts intact', () => {
      expect(splitForTelegram('سلام')).toEqual(['سلام']);
    });
    it('splits long texts into ≤4096-char chunks', () => {
      const text = 'کلمه '.repeat(3000);
      const chunks = splitForTelegram(text);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
      expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim());
    });
  });
});
