import { Inject, Injectable, Logger } from '@nestjs/common';
import { Ticket } from '../../database/entities/ticket.entity';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { TicketDepartment } from '../../database/enums';
import { TicketsService } from '../tickets/tickets.service';
import { MessagesService } from '../messages/messages.service';
import { UsersService } from '../users/users.service';
import { BotStateService } from './bot-state.service';
import { RegistrationService } from './registration.service';
import { sendEphemeral, TELEGRAM_GATEWAY, TelegramGateway } from '../telegram/telegram-gateway.interface';
import {
  BTN_CANCEL_TICKET,
  BTN_WIZARD_BACK,
  departmentByLabel,
  departmentKeyboard,
  mainMenuKeyboard,
  ticketCancelKeyboard,
} from '../telegram/keyboards';
import {
  ASK_DEPARTMENT,
  ASK_DESCRIPTION,
  ASK_TITLE,
  DEPARTMENT_INVALID,
  DESCRIPTION_INVALID,
  TICKET_ACTIVE_EXISTS,
  TICKET_RETRY_FAILED,
  TITLE_INVALID,
  WIZARD_CANCELED,
  ticketConfirmationMessage,
} from '../../common/bot-messages';
import { BotFlowState } from './bot-state.types';

export const MIN_TITLE_LENGTH = 3;
export const MAX_TITLE_LENGTH = 120; // matches tickets.subject varchar(120)
export const MIN_DESCRIPTION_LENGTH = 10;

/**
 * The STAGED ticket-creation wizard (feature requirement §3):
 *   📝 عنوان → 🏢 دپارتمان (custom reply keyboard ONLY — free text can never
 *   become a department) → 💬 متن → atomic finalization → confirmation
 *   template with the REAL Jalali timestamp.
 *
 * §4's hard rule lives in the router: while any TICKET_* state is active the
 * user's text is consumed HERE and never reaches the general/AI handler.
 *
 * Crash/DB-error semantics (§4/§8): the finalize step keeps the wizard state
 * with the description on failure, so nothing the user typed is lost and the
 * retry needs no re-typing; the idempotency walls (update_id unique index,
 * active-ticket partial index) make even double-fires safe.
 */
@Injectable()
export class TicketFlowService {
  private readonly logger = new Logger('TicketFlow');

  constructor(
    private readonly ticketsService: TicketsService,
    private readonly messagesService: MessagesService,
    private readonly usersService: UsersService,
    private readonly botState: BotStateService,
    private readonly registration: RegistrationService,
    @Inject(TELEGRAM_GATEWAY) private readonly gateway: TelegramGateway,
  ) {}

  /** Entry via /new or 🎫 ثبت تیکت جدید — requires a completed profile. */
  async start(user: TelegramUser, chatId: string): Promise<void> {
    const active = await this.ticketsService.findActiveTicket(user.id);
    if (active) {
      await sendEphemeral(this.gateway, chatId, TICKET_ACTIVE_EXISTS(active.ticket_number), this.logger, {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }
    await this.botState.set(user.id, 'TICKET_TITLE');
    await sendEphemeral(this.gateway, chatId, ASK_TITLE, this.logger, {
      reply_markup: ticketCancelKeyboard(),
    });
  }

  /**
   * Consumes a text while a wizard step is active. Returns false when no
   * wizard state exists (the router falls through to default routing).
   * `updateId` keys the finalize's idempotency (the description message is
   * stored under the TRIGGERING update — a sweeper re-run can never double-create).
   */
  async handleText(
    user: TelegramUser,
    chatId: string,
    text: string,
    updateId: string | null,
  ): Promise<boolean> {
    const state = await this.botState.get(user);
    if (!state) return false;

    switch (state.flow) {
      case 'TICKET_TITLE':
        if (text === BTN_CANCEL_TICKET) return this.cancel(user, chatId);
        await this.handleTitle(user, chatId, state, text);
        return true;
      case 'TICKET_DEPARTMENT':
        if (text === BTN_CANCEL_TICKET) return this.cancel(user, chatId);
        if (text === BTN_WIZARD_BACK) {
          await this.botState.set(user.id, 'TICKET_TITLE', { title: state.data?.title });
          await sendEphemeral(this.gateway, chatId, ASK_TITLE, this.logger, {
            reply_markup: ticketCancelKeyboard(),
          });
          return true;
        }
        await this.handleDepartment(user, chatId, state, text);
        return true;
      case 'TICKET_DESCRIPTION':
      case 'TICKET_RETRY':
        if (text === BTN_CANCEL_TICKET) return this.cancel(user, chatId);
        await this.handleDescription(user, chatId, state, text, updateId);
        return true;
      default:
        return false;
    }
  }

  /** §4: cancel must work at EVERY step, clearing the state cleanly. */
  async cancel(user: TelegramUser, chatId: string): Promise<boolean> {
    await this.botState.clear(user.id);
    await sendEphemeral(this.gateway, chatId, WIZARD_CANCELED, this.logger, {
      reply_markup: mainMenuKeyboard(),
    });
    return true;
  }

  private async handleTitle(
    user: TelegramUser,
    chatId: string,
    state: BotFlowState,
    text: string,
  ): Promise<void> {
    const title = text.replace(/\s+/g, ' ').trim();
    if (title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) {
      await sendEphemeral(this.gateway, chatId, TITLE_INVALID, this.logger, {
        reply_markup: ticketCancelKeyboard(),
      });
      return;
    }
    await this.botState.set(user.id, 'TICKET_DEPARTMENT', {
      title,
      department: state.data?.department,
      description: state.data?.description,
    });
    await sendEphemeral(this.gateway, chatId, ASK_DEPARTMENT, this.logger, {
      reply_markup: departmentKeyboard(),
    });
  }

  private async handleDepartment(
    user: TelegramUser,
    chatId: string,
    state: BotFlowState,
    text: string,
  ): Promise<void> {
    const option = departmentByLabel(text);
    if (!option) {
      await sendEphemeral(this.gateway, chatId, DEPARTMENT_INVALID, this.logger, {
        reply_markup: departmentKeyboard(),
      });
      return;
    }
    await this.botState.set(user.id, 'TICKET_DESCRIPTION', {
      title: String(state.data?.title ?? ''),
      department: option.key,
      description: state.data?.description,
    });
    await sendEphemeral(this.gateway, chatId, ASK_DESCRIPTION, this.logger, {
      reply_markup: ticketCancelKeyboard(),
    });
  }

  private async handleDescription(
    user: TelegramUser,
    chatId: string,
    state: BotFlowState,
    text: string,
    updateId: string | null,
  ): Promise<void> {
    const description = text.trim();
    if (description.length < MIN_DESCRIPTION_LENGTH) {
      await sendEphemeral(this.gateway, chatId, DESCRIPTION_INVALID, this.logger, {
        reply_markup: ticketCancelKeyboard(),
      });
      return;
    }

    const title = String(state.data?.title ?? '');
    const department = state.data?.department as TicketDepartment | undefined;
    if (!title || !department) {
      // state was partially lost (manual DB edit, corrupt jsonb) — restart safely
      await this.botState.set(user.id, 'TICKET_TITLE', {});
      await sendEphemeral(this.gateway, chatId, ASK_TITLE, this.logger, {
        reply_markup: ticketCancelKeyboard(),
      });
      return;
    }

    // store the description FIRST (flow TICKET_RETRY) — if the transaction
    // below fails, the text is already safe in the state for the retry (§4)
    await this.botState.set(user.id, 'TICKET_RETRY', { title, department, description });
    await this.finalize(user, chatId, updateId);
  }

  /** The final, idempotent registration. Called from handleDescription. */
  private async finalize(
    user: TelegramUser,
    chatId: string,
    updateId: string | null,
  ): Promise<void> {
    const state = (await this.botState.get(user))!;
    const title = String(state.data?.title ?? '');
    const department = state.data?.department as TicketDepartment;
    const description = String(state.data?.description ?? '');

    try {
      // DEDUP-FIRST: a sweeper re-run of the same update lands here after the
      // ticket already exists — never create a second one for that update.
      const stored = updateId
        ? await this.messagesService.findByTelegramUpdateId(updateId)
        : null;

      let ticket: Ticket;
      if (stored) {
        // the update already created its ticket — pin to the ORIGINAL one
        const original = await this.ticketsService.findById(stored.ticket_id);
        if (!original) throw new Error(`stored message references missing ticket ${stored.ticket_id}`);
        ticket = original;
      } else {
        const result = await this.ticketsService.createTicketWithFirstMessage({
          user_id: user.id,
          subject: title,
          department,
          description,
          telegram_update_id: updateId ?? `manual-${Date.now()}`,
        });
        ticket = result.ticket;
      }

      await this.botState.clear(user.id);
      await sendEphemeral(
        this.gateway,
        chatId,
        ticketConfirmationMessage(ticket, new Date(ticket.created_at)),
        this.logger,
        { reply_markup: mainMenuKeyboard(), parse_mode: 'HTML' },
      );
      this.logger.log(`ticket ${ticket.ticket_number} registered for user ${user.telegram_id}`);
    } catch (e) {
      // §4: DB error ⇒ NO success message; the state (with the description)
      // stays in TICKET_RETRY so the next text retries the finalize.
      this.logger.error(
        `ticket finalize failed for user ${user.telegram_id}: ${(e as Error).message}`,
      );
      await sendEphemeral(this.gateway, chatId, TICKET_RETRY_FAILED, this.logger, {
        reply_markup: ticketCancelKeyboard(),
      });
    }
  }
}
