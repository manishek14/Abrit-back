import { Inject, Injectable, Logger } from '@nestjs/common';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { TicketStatus } from '../../database/enums';
import { TicketsService } from '../tickets/tickets.service';
import { sendEphemeral, TELEGRAM_GATEWAY, TelegramGateway } from '../telegram/telegram-gateway.interface';
import { RegistrationService } from './registration.service';
import { TicketFlowService } from './ticket-flow.service';
import { MyTicketsService } from './mytickets.service';
import { BotStateService } from './bot-state.service';
import { mainMenuKeyboard } from '../telegram/keyboards';
import {
  REG_REQUIRED,
  WIZARD_CANCELED,
  helpText,
  profileCard,
  trackCard,
  trackNoTicket,
} from '../../common/bot-messages';

export interface ParsedCommand {
  name: string;
  raw: string;
}

/**
 * Bot commands (feature round): /start, /help, /new, /mytickets, /profile,
 * /status, /close, /cancel — the profile gate (§1) is enforced centrally in
 * `requireProfile`, so a gated user can never reach ticket features with ANY
 * command spelling. Announcements/notifications stay durable outbox messages;
 * informational echoes are ephemeral.
 */
@Injectable()
export class CommandsService {
  private readonly logger = new Logger('Commands');

  constructor(
    private readonly ticketsService: TicketsService,
    private readonly registration: RegistrationService,
    private readonly ticketFlow: TicketFlowService,
    private readonly myTickets: MyTicketsService,
    private readonly botState: BotStateService,
    @Inject(TELEGRAM_GATEWAY) private readonly gateway: TelegramGateway,
  ) {}

  async handle(user: TelegramUser, chatId: string, command: ParsedCommand): Promise<void> {
    switch (command.name) {
      case 'start':
        return this.handleStart(user, chatId);
      case 'help':
        return this.handleHelp(user, chatId);
      case 'new':
        return this.handleNew(user, chatId);
      case 'mytickets':
        return this.handleMyTickets(user, chatId);
      case 'profile':
        return this.handleProfile(user, chatId);
      case 'status':
        return this.handleStatus(user, chatId);
      case 'close':
        return this.handleClose(user, chatId);
      case 'cancel':
        return this.handleCancel(user, chatId);
      default:
        return void sendEphemeral(this.gateway, chatId, helpText(), this.logger, {
          reply_markup: this.registration.isComplete(user) ? mainMenuKeyboard() : undefined,
        });
    }
  }

  /** /start — the front door: complete profile → menu; else registration. */
  private async handleStart(user: TelegramUser, chatId: string): Promise<void> {
    // a stale flow must never survive an explicit /start (§8)
    await this.botState.clear(user.id);
    if (!this.registration.isComplete(user)) {
      await this.registration.start(user, chatId);
      return;
    }
    await sendEphemeral(
      this.gateway,
      chatId,
      `سلام ${user.full_name}! به پشتیبانی ABRIT خوش آمدید.\nاز منوی زیر انتخاب کنید یا سؤال خود را مستقیم بپرسید.`,
      this.logger,
      { reply_markup: mainMenuKeyboard() },
    );
  }

  private async handleHelp(user: TelegramUser, chatId: string): Promise<void> {
    await sendEphemeral(this.gateway, chatId, helpText(), this.logger, {
      reply_markup: this.registration.isComplete(user) ? mainMenuKeyboard() : undefined,
    });
  }

  private async handleNew(user: TelegramUser, chatId: string): Promise<void> {
    if (!(await this.requireProfile(user, chatId))) return;
    await this.ticketFlow.start(user, chatId);
  }

  private async handleMyTickets(user: TelegramUser, chatId: string): Promise<void> {
    if (!(await this.requireProfile(user, chatId))) return;
    await this.myTickets.show(user, chatId, 1);
  }

  private async handleProfile(user: TelegramUser, chatId: string): Promise<void> {
    if (!(await this.requireProfile(user, chatId))) return;
    await sendEphemeral(
      this.gateway,
      chatId,
      profileCard(user),
      this.logger,
      { reply_markup: mainMenuKeyboard() },
    );
  }

  private async handleStatus(user: TelegramUser, chatId: string): Promise<void> {
    if (!(await this.requireProfile(user, chatId))) return;
    const ticket =
      (await this.ticketsService.findActiveTicket(user.id)) ??
      (await this.ticketsService.findLastTicket(user.id));

    if (!ticket) {
      await sendEphemeral(this.gateway, chatId, trackNoTicket(), this.logger, {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }
    await sendEphemeral(this.gateway, chatId, trackCard(ticket), this.logger, {
      reply_markup: mainMenuKeyboard(),
    });
  }

  private async handleClose(user: TelegramUser, chatId: string): Promise<void> {
    if (!(await this.requireProfile(user, chatId))) return;
    const active = await this.ticketsService.findActiveTicket(user.id);
    if (!active) {
      await sendEphemeral(this.gateway, chatId, 'تیکت فعالی برای بستن ندارید.', this.logger, {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }
    // changeStatus inserts the SYSTEM notification (PENDING) — the dispatcher delivers it
    await this.ticketsService.changeStatus(active.id, TicketStatus.CLOSED, 'USER');
  }

  /** /cancel — universal escape hatch from ANY flow (§8). */
  private async handleCancel(user: TelegramUser, chatId: string): Promise<void> {
    await this.botState.clear(user.id);
    await sendEphemeral(this.gateway, chatId, WIZARD_CANCELED, this.logger, {
      reply_markup: mainMenuKeyboard(),
    });
  }

  /** §1/§8 gate — every ticket feature routes through here. */
  private async requireProfile(user: TelegramUser, chatId: string): Promise<boolean> {
    if (this.registration.isComplete(user)) return true;
    await sendEphemeral(this.gateway, chatId, REG_REQUIRED, this.logger);
    await this.registration.start(user, chatId);
    return false;
  }
}

/** Extracts a bot command like "/new", "/close@AbrITBot" or "/status جزئیات" — null for plain text. */
export function parseCommand(text: string): ParsedCommand | null {
  if (!text.startsWith('/')) return null;
  const name = text.slice(1).split(/[\s@]/)[0]?.toLowerCase() ?? '';
  if (!name) return null;
  return { name, raw: text };
}
