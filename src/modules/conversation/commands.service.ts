import { Inject, Injectable, Logger } from '@nestjs/common';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { MessageRole, TicketStatus } from '../../database/enums';
import { TICKET_STATUS_LABELS } from '../../common/ticket-labels';
import { MessagesService } from '../messages/messages.service';
import { TicketsService } from '../tickets/tickets.service';
import { sendEphemeral, TELEGRAM_GATEWAY, TelegramGateway } from '../telegram/telegram-gateway.interface';

export interface ParsedCommand {
  name: string;
  raw: string;
}

export const WELCOME_TEXT =
  'سلام! به پشتیبانی AbrIT خوش آمدید.\n' +
  'برای ثبت درخواست جدید می‌توانید مستقیماً مشکل خود را بنویسید یا /new را بزنید.\n' +
  'وضعیت تیکت: /status — بستن تیکت: /close — راهنما: /help';

export const HELP_TEXT =
  'راهنمای دستورات:\n' +
  '/new — ایجاد تیکت جدید\n' +
  '/status — مشاهده وضعیت تیکت\n' +
  '/close — بستن تیکت فعلی\n' +
  '/help — نمایش همین راهنما\n\n' +
  'همچنین می‌توانید بدون دستور، مشکل خود را مستقیماً بنویسید تا تیکت ساخته شود.';

export const UNKNOWN_COMMAND_TEXT =
  'دستور ناشناخته است. فهرست دستورها را با /help ببینید.';

/** Extracts a bot command like "/new", "/close@AbrITBot" or "/status جزئیات" — null for plain text. */
export function parseCommand(text: string): ParsedCommand | null {
  if (!text.startsWith('/')) return null;
  const name = text.slice(1).split(/[\s@]/)[0]?.toLowerCase() ?? '';
  if (!name) return null;
  return { name, raw: text };
}

/**
 * Bot command behaviour (plan §6). /new announcements and /close notifications
 * are durable outbox messages; help/status echoes are ephemeral (re-requestable).
 */
@Injectable()
export class CommandsService {
  private readonly logger = new Logger('Commands');

  constructor(
    private readonly ticketsService: TicketsService,
    private readonly messagesService: MessagesService,
    @Inject(TELEGRAM_GATEWAY) private readonly gateway: TelegramGateway,
  ) {}

  async handle(user: TelegramUser, chatId: string, command: ParsedCommand): Promise<void> {
    switch (command.name) {
      case 'start':
        return void sendEphemeral(this.gateway, chatId, WELCOME_TEXT, this.logger);
      case 'help':
        return void sendEphemeral(this.gateway, chatId, HELP_TEXT, this.logger);
      case 'new':
        return this.handleNew(user, chatId);
      case 'status':
        return this.handleStatus(user, chatId);
      case 'close':
        return this.handleClose(user, chatId);
      default:
        return void sendEphemeral(this.gateway, chatId, UNKNOWN_COMMAND_TEXT, this.logger);
    }
  }

  private async handleNew(user: TelegramUser, chatId: string): Promise<void> {
    const { ticket, created } = await this.ticketsService.ensureActiveTicket(user.id, null);
    if (created) {
      // durable announcement — flows through the outbox like every ticket event
      await this.messagesService.addOutboundMessage({
        ticket_id: ticket.id,
        role: MessageRole.SYSTEM,
        content: `تیکت ${ticket.ticket_number} ایجاد شد.\nلطفاً شرح مشکل خود را بنویسید.`,
      });
    } else {
      await sendEphemeral(
        this.gateway,
        chatId,
        `شما تیکت فعال (${ticket.ticket_number}) دارید. لطفاً درخواست جدید را پس از بستن تیکت فعلی (با /close) ارسال کنید.`,
        this.logger,
      );
    }
  }

  private async handleStatus(user: TelegramUser, chatId: string): Promise<void> {
    const ticket =
      (await this.ticketsService.findActiveTicket(user.id)) ??
      (await this.ticketsService.findLastTicket(user.id));

    if (!ticket) {
      await sendEphemeral(
        this.gateway,
        chatId,
        'تیکتی برای نمایش وجود ندارد. برای شروع، مشکل خود را بنویسید یا /new را بزنید.',
        this.logger,
      );
      return;
    }
    await sendEphemeral(
      this.gateway,
      chatId,
      `تیکت ${ticket.ticket_number} — وضعیت: ${TICKET_STATUS_LABELS[ticket.status]}\nبرای بستن: /close`,
      this.logger,
    );
  }

  private async handleClose(user: TelegramUser, chatId: string): Promise<void> {
    const active = await this.ticketsService.findActiveTicket(user.id);
    if (!active) {
      await sendEphemeral(this.gateway, chatId, 'تیکت فعالی برای بستن ندارید.', this.logger);
      return;
    }
    // changeStatus inserts the SYSTEM notification (PENDING) — the dispatcher delivers it
    await this.ticketsService.changeStatus(active.id, TicketStatus.CLOSED, 'USER');
  }
}
