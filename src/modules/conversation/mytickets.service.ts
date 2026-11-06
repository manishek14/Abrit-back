import { Inject, Injectable, Logger } from '@nestjs/common';
import { Ticket } from '../../database/entities/ticket.entity';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { Message } from '../../database/entities/message.entity';
import { TicketStatus } from '../../database/enums';
import { TicketsService } from '../tickets/tickets.service';
import { MessagesService } from '../messages/messages.service';
import { BotStateService } from './bot-state.service';
import { sendEphemeral, TELEGRAM_GATEWAY, TelegramGateway } from '../telegram/telegram-gateway.interface';
import {
  BTN_BACK_TO_MY_TICKETS,
  BTN_SEND_MESSAGE,
  BTN_TICKET_INFO,
  MYT_CALLBACK_PAGE,
  MYT_CALLBACK_VIEW,
  MYT_PAGE_SIZE,
  DEPARTMENT_LABELS,
  mainMenuKeyboard,
  myTicketsInlineKeyboard,
  ticketViewKeyboard,
} from '../telegram/keyboards';
import {
  MY_TICKETS_EMPTY,
  REPLY_ASK,
  TICKET_CLOSED_FOR_REPLY,
  TICKET_FORBIDDEN,
  TICKET_NOT_FOUND,
  escapeHtml,
  myTicketsHeader,
  myTicketsLine,
} from '../../common/bot-messages';
import { formatJalaliInline } from '../../common/jalali';
import { TICKET_STATUS_LABELS } from '../../common/ticket-labels';

const MAX_USER_REPLY_LENGTH = 3000;

export interface StoredTicketReply {
  ticket: Ticket;
  userMessage: Message;
}

/**
 * /mytickets + 📋 تیکت‌های من (feature requirement §2):
 *   - ONLY the caller's tickets are ever listed or opened — every lookup goes
 *     through `ownedTicket` (§8: cross-user access is impossible, a foreign id
 *     reads exactly like a missing ticket);
 *   - the list renders the project's REAL statuses/departments with
 *     pagination; per-ticket selection uses INLINE callbacks (the one place
 *     the spec allows them), everything else is reply keyboards;
 *   - a follow-up message (💬 ارسال پیام) is stored INTO the ticket keyed by
 *     the update id (idempotent + resumable) and RETURNS to the router, which
 *     runs the existing durable AI-reply pipeline — general chat is never involved.
 */
@Injectable()
export class MyTicketsService {
  private readonly logger = new Logger('MyTickets');

  constructor(
    private readonly ticketsService: TicketsService,
    private readonly messagesService: MessagesService,
    private readonly botState: BotStateService,
    @Inject(TELEGRAM_GATEWAY) private readonly gateway: TelegramGateway,
  ) {}

  async show(user: TelegramUser, chatId: string, page = 1): Promise<void> {
    const safePage = Math.max(1, Math.floor(page));
    const { data, meta } = await this.ticketsService.listUserTickets(
      user.id,
      safePage,
      MYT_PAGE_SIZE,
    );

    if (meta.total === 0) {
      await this.botState.clear(user.id);
      await sendEphemeral(this.gateway, chatId, MY_TICKETS_EMPTY, this.logger, {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    const totalPages = Math.max(1, Math.ceil(meta.total / MYT_PAGE_SIZE));
    const lines = data.map((t, i) => myTicketsLine(i + 1, t));
    await sendEphemeral(
      this.gateway,
      chatId,
      `${myTicketsHeader(safePage, totalPages, meta.total)}\n\n${lines.join('\n\n')}`,
      this.logger,
      { reply_markup: myTicketsInlineKeyboard(data, safePage, totalPages) },
    );
  }

  /**
   * Inline callback routing (myt:view:<uuid> / myt:page:<n>). The callback's
   * `from` is the presser — ownership is enforced on EVERY view.
   */
  async handleCallback(
    user: TelegramUser,
    chatId: string,
    callbackQueryId: string,
    data: string,
  ): Promise<void> {
    await this.gateway.answerCallbackQuery?.(callbackQueryId);
    if (data.startsWith(MYT_CALLBACK_PAGE)) {
      const page = Number(data.slice(MYT_CALLBACK_PAGE.length));
      await this.show(user, chatId, Number.isInteger(page) && page >= 1 ? page : 1);
      return;
    }
    if (data.startsWith(MYT_CALLBACK_VIEW)) {
      await this.viewTicket(user, chatId, data.slice(MYT_CALLBACK_VIEW.length));
      return;
    }
    // unknown / myt:noop — the callback was already answered, nothing else to do
  }

  /** The ticket detail card + the view keyboard; sets TICKET_VIEW state. */
  async viewTicket(user: TelegramUser, chatId: string, ticketId: string): Promise<void> {
    const ticket = await this.ownedTicket(user, chatId, ticketId);
    if (!ticket) return; // the guard already told the user why not

    await this.botState.set(user.id, 'TICKET_VIEW', { ticketId: ticket.id });
    await sendEphemeral(this.gateway, chatId, this.detailsCard(ticket), this.logger, {
      reply_markup: ticketViewKeyboard(),
      parse_mode: 'HTML',
    });
  }

  /** Reply-keyboard actions while a ticket is being viewed (TICKET_VIEW). */
  async handleViewAction(user: TelegramUser, chatId: string, text: string): Promise<boolean> {
    const state = await this.botState.get(user);
    if (!state || state.flow !== 'TICKET_VIEW') return false;

    switch (text) {
      case BTN_SEND_MESSAGE: {
        const ticket = await this.ownedTicket(user, chatId, String(state.data?.ticketId ?? ''));
        if (!ticket) return true; // state cleaned up by the guard
        if (ticket.status === TicketStatus.CLOSED) {
          await this.botState.clear(user.id);
          await sendEphemeral(this.gateway, chatId, TICKET_CLOSED_FOR_REPLY, this.logger, {
            reply_markup: mainMenuKeyboard(),
          });
          return true;
        }
        await this.botState.set(user.id, 'TICKET_REPLY', { ticketId: ticket.id });
        await sendEphemeral(this.gateway, chatId, REPLY_ASK, this.logger, {
          reply_markup: ticketViewKeyboard(),
        });
        return true;
      }
      case BTN_TICKET_INFO: {
        const ticket = await this.ownedTicket(user, chatId, String(state.data?.ticketId ?? ''));
        if (!ticket) return true;
        await sendEphemeral(this.gateway, chatId, this.detailsCard(ticket), this.logger, {
          reply_markup: ticketViewKeyboard(),
          parse_mode: 'HTML',
        });
        return true;
      }
      case BTN_BACK_TO_MY_TICKETS:
        await this.botState.clear(user.id);
        await this.show(user, chatId, 1);
        return true;
      default:
        return false;
    }
  }

  /**
   * A text while TICKET_REPLY is active → stored INTO this ticket (never the
   * general chat). Returns the stored row for the router's durable AI-reply
   * step, or null when the text was not a ticket reply.
   */
  async handleTicketReply(
    user: TelegramUser,
    chatId: string,
    text: string,
    updateId: string,
  ): Promise<StoredTicketReply | null> {
    const state = await this.botState.get(user);
    if (!state || state.flow !== 'TICKET_REPLY') return null;

    if (text === BTN_BACK_TO_MY_TICKETS) {
      await this.botState.clear(user.id);
      await this.show(user, chatId, 1);
      return null;
    }

    const ticket = await this.ownedTicket(user, chatId, String(state.data?.ticketId ?? ''));
    if (!ticket) return null;

    if (text.length > MAX_USER_REPLY_LENGTH) {
      await sendEphemeral(
        this.gateway,
        chatId,
        'پیام شما بیش از حد طولانی است (حداکثر ۳۰۰۰ کاراکتر).',
        this.logger,
      );
      return null;
    }

    // RESUMABLE (inherited from the old orchestrator tail): a re-run after a
    // crash finds the already-stored row and continues with the reply.
    const stored = await this.messagesService.findByTelegramUpdateId(updateId);
    const userMessage =
      stored ??
      (await this.messagesService.addUserMessage({
        ticket_id: ticket.id,
        content: text,
        telegram_update_id: updateId,
      }));

    return { ticket, userMessage };
  }

  private async ownedTicket(
    user: TelegramUser,
    chatId: string,
    ticketId: string,
  ): Promise<Ticket | null> {
    const ticket = ticketId ? await this.ticketsService.findById(ticketId) : null;
    // ownership: a foreign id and an unknown id are indistinguishable (§8)
    if (!ticket || ticket.user_id !== user.id) {
      await sendEphemeral(this.gateway, chatId, TICKET_FORBIDDEN, this.logger, {
        reply_markup: mainMenuKeyboard(),
      });
      await this.botState.clear(user.id);
      return null;
    }
    return ticket;
  }

  private detailsCard(ticket: Ticket): string {
    const created = formatJalaliInline(new Date(ticket.created_at));
    const department = ticket.department ? DEPARTMENT_LABELS[ticket.department] : '—';
    const status = TICKET_STATUS_LABELS[ticket.status];
    return [
      `📋 <b>تیکت ${escapeHtml(ticket.ticket_number)}</b>`,
      '',
      `عنوان: ${escapeHtml(ticket.subject ?? '—')}`,
      `دپارتمان: ${escapeHtml(department)}`,
      `وضعیت: ${escapeHtml(status)}`,
      `تاریخ ثبت: ${created}`,
    ].join('\n');
  }
}
