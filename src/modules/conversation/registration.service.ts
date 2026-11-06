import { Inject, Injectable, Logger } from '@nestjs/common';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { UsersService } from '../users/users.service';
import { BotStateService } from './bot-state.service';
import {
  sendEphemeral,
  TELEGRAM_GATEWAY,
  TelegramGateway,
} from '../telegram/telegram-gateway.interface';
import {
  BTN_REG_BACK,
  BTN_SHARE_CONTACT,
  mainMenuKeyboard,
  registrationNameKeyboard,
  registrationPhoneKeyboard,
} from '../telegram/keyboards';
import {
  REG_ASK_PHONE,
  REG_CONTACT_OWNER_MISMATCH,
  REG_DONE,
  REG_NAME_INVALID,
  REG_NAME_TOO_LONG,
  REG_PHONE_INVALID,
  REG_REQUIRED,
  REG_WELCOME,
} from '../../common/bot-messages';

export const MAX_NAME_LENGTH = 120;

/**
 * MANDATORY two-step profile registration (feature requirement §1):
 *   step 1 — نام و نام خانوادگی (free text, validated),
 *   step 2 — شماره همراه (request_contact button PREFERRED, manual entry as
 *            the documented fallback, contact ownership verified).
 * Until both steps are stored, EVERY main feature is gated (§8) — the router
 * consults this service before anything else.
 */
@Injectable()
export class RegistrationService {
  private readonly logger = new Logger('Registration');

  constructor(
    private readonly usersService: UsersService,
    private readonly botState: BotStateService,
    @Inject(TELEGRAM_GATEWAY) private readonly gateway: TelegramGateway,
  ) {}

  isComplete(user: TelegramUser): boolean {
    return this.usersService.isProfileComplete(user);
  }

  /** (Re)starts registration at step 1. Also the landing for gated users. */
  async start(user: TelegramUser, chatId: string, opts: { gated?: boolean } = {}): Promise<void> {
    await this.botState.set(user.id, 'REGISTER_NAME');
    const text = opts.gated ? `${REG_REQUIRED}\n\n${REG_WELCOME}` : REG_WELCOME;
    await sendEphemeral(this.gateway, chatId, text, this.logger, {
      reply_markup: registrationNameKeyboard(),
    });
  }

  /**
   * The router's entry for ANY text while a REGISTER_* flow is active.
   * Returns true when the text was consumed by registration (the caller must
   * NOT route it anywhere else — §4's «فقط توسط جریان ثبت‌نام پردازش شود»).
   */
  async handleText(user: TelegramUser, chatId: string, text: string): Promise<boolean> {
    const state = await this.botState.get(user);
    if (!state || (state.flow !== 'REGISTER_NAME' && state.flow !== 'REGISTER_PHONE')) {
      return false;
    }

    if (text === BTN_REG_BACK && state.flow === 'REGISTER_PHONE') {
      await this.botState.set(user.id, 'REGISTER_NAME', {});
      await sendEphemeral(this.gateway, chatId, REG_WELCOME, this.logger, {
        reply_markup: registrationNameKeyboard(),
      });
      return true;
    }

    if (state.flow === 'REGISTER_NAME') {
      await this.handleName(user, chatId, text);
      return true;
    }

    // REGISTER_PHONE — typed number (the documented manual fallback)
    await this.handleTypedPhone(user, chatId, text);
    return true;
  }

  /** The router's entry for `message.contact` updates (keyboard button). */
  async handleContact(
    user: TelegramUser,
    chatId: string,
    contact: { phone_number?: string; user_id?: number | string },
  ): Promise<void> {
    const state = await this.botState.get(user);
    if (!state || state.flow !== 'REGISTER_PHONE') {
      // a contact outside the phone step carries no registration meaning
      await sendEphemeral(this.gateway, chatId, REG_REQUIRED, this.logger, {
        reply_markup: registrationPhoneKeyboard(),
      });
      return;
    }

    // §1: the shared contact MUST belong to the sender — otherwise anyone
    // could register a number they do not own (spoofed contact forwarding).
    if (contact.user_id !== undefined && String(contact.user_id) !== String(user.telegram_id)) {
      await sendEphemeral(this.gateway, chatId, REG_CONTACT_OWNER_MISMATCH, this.logger, {
        reply_markup: registrationPhoneKeyboard(),
      });
      return;
    }

    const phone = normalizeIranianMobile(contact.phone_number ?? '');
    if (!phone) {
      await sendEphemeral(this.gateway, chatId, REG_PHONE_INVALID, this.logger, {
        reply_markup: registrationPhoneKeyboard(),
      });
      return;
    }

    await this.complete(user, chatId, phone);
  }

  private async handleName(user: TelegramUser, chatId: string, text: string): Promise<void> {
    const name = text.replace(/\s+/g, ' ').trim();

    if (name.length > MAX_NAME_LENGTH) {
      await sendEphemeral(this.gateway, chatId, REG_NAME_TOO_LONG, this.logger);
      return;
    }
    if (!isValidFullName(name)) {
      await sendEphemeral(this.gateway, chatId, REG_NAME_INVALID, this.logger);
      return;
    }

    await this.botState.set(user.id, 'REGISTER_PHONE', { name });
    await sendEphemeral(this.gateway, chatId, REG_ASK_PHONE, this.logger, {
      reply_markup: registrationPhoneKeyboard(),
    });
  }

  private async handleTypedPhone(
    user: TelegramUser,
    chatId: string,
    text: string,
  ): Promise<void> {
    const phone = normalizeIranianMobile(text);
    if (!phone) {
      await sendEphemeral(this.gateway, chatId, REG_PHONE_INVALID, this.logger, {
        reply_markup: registrationPhoneKeyboard(),
      });
      return;
    }
    await this.complete(user, chatId, phone);
  }

  private async complete(user: TelegramUser, chatId: string, phone: string): Promise<void> {
    const state = await this.botState.get(user);
    const fullName = String(state?.data?.name ?? '').trim();
    if (!fullName) {
      // state expired mid-registration → restart at step 1 (nothing was lost:
      // the name was never persisted, so the user simply types it again)
      await this.start(user, chatId);
      return;
    }

    await this.usersService.completeProfile(user.id, {
      full_name: fullName,
      phone,
    });
    await this.botState.clear(user.id);
    this.logger.log(`profile completed for user ${user.telegram_id}`);
    await sendEphemeral(
      this.gateway,
      chatId,
      `${REG_DONE}\n\n${fullName} عزیز، خوش آمدید!`,
      this.logger,
      { reply_markup: mainMenuKeyboard() },
    );
  }
}

/**
 * Persian or Latin letters (+ internal spaces / ZWNJ), at least TWO parts of
 * ≥2 letters each — «علی» alone is not a name AND family name; digits and
 * control characters never pass.
 */
export function isValidFullName(name: string): boolean {
  if (name.length < 5 || name.length > MAX_NAME_LENGTH) return false;
  if (/[\d\u00a0\u200b-\u200f\u2028\u2029]/.test(name)) return false; // digits/zero-width abuse
  const parts = name
    .split(/[\s\u200c]+/)
    .filter((p) => p.length > 0)
    .filter((p) => /^[\p{L}\p{M}.'-]+$/u.test(p));
  if (parts.length < 2) return false;
  return parts.every((p) => p.length >= 2);
}

/**
 * Iranian mobile normalization: accepts 09123456789, 9123456789,
 * +989123456789, 00989123456789 (spaces/dashes ignored) → 09123456789.
 */
export function normalizeIranianMobile(raw: string): string | null {
  const digits = raw.replace(/[\s()\-.]/g, '');
  let normalized = digits.replace(/^\+98/, '0').replace(/^0098/, '0');
  if (/^9\d{9}$/.test(normalized)) normalized = `0${normalized}`; // dropped leading zero
  if (/^98(?=9\d{9}$)/.test(normalized)) normalized = `0${normalized.slice(2)}`; // bare country code
  return /^09\d{9}$/.test(normalized) ? normalized : null;
}
