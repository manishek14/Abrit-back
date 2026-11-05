import { Injectable, NotFoundException } from '@nestjs/common';
import { Brackets, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { escapeLike, Paginated, toPaginated } from '../../common/pagination';
import { firstRawRow } from '../../common/utils/raw-rows';
import { EventsService } from '../../common/events/events.service';

export interface UpsertTelegramUserInput {
  telegram_id: string;
  chat_id?: string | null;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  language_code?: string | null;
}

export type UserWithTicketCount = TelegramUser & { ticket_count: number };

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(TelegramUser) private readonly repo: Repository<TelegramUser>,
    private readonly events: EventsService,
  ) {}

  /**
   * Single-statement upsert — one row per Telegram user, always refreshed with
   * the latest profile data from the update payload. chat_id defaults to
   * telegram_id for private chats and is stored independently (owner's request).
   *
   * `(xmax = 0)` is the standard Postgres trick to learn whether the row was
   * freshly INSERTed or UPDATEd by the conflict clause — only inserts emit
   * 'user.created', so the panel's user list refreshes exactly when a new
   * person writes to the bot (and not on every profile/last_seen refresh).
   */
  async upsertTelegramUser(input: UpsertTelegramUserInput): Promise<TelegramUser> {
    const rows = await this.repo.query(
      `INSERT INTO telegram_users
         (telegram_id, chat_id, username, first_name, last_name, language_code, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (telegram_id) DO UPDATE SET
         chat_id        = COALESCE(EXCLUDED.chat_id, telegram_users.chat_id),
         username       = EXCLUDED.username,
         first_name     = EXCLUDED.first_name,
         last_name      = EXCLUDED.last_name,
         language_code  = EXCLUDED.language_code,
         last_seen_at   = now(),
         updated_at     = now()
       RETURNING *, (xmax = 0) AS _was_inserted`,
      [
        input.telegram_id,
        input.chat_id ?? input.telegram_id,
        input.username ?? null,
        input.first_name ?? null,
        input.last_name ?? null,
        input.language_code ?? null,
      ],
    );
    const row = firstRawRow<Record<string, unknown>>(rows);
    if (row?._was_inserted === true) {
      this.events.emit('user.created', { user: row as unknown as TelegramUser });
    }
    return row as unknown as TelegramUser;
  }

  async findByTelegramId(telegram_id: string): Promise<TelegramUser | null> {
    return this.repo.findOneBy({ telegram_id });
  }

  async findById(id: string): Promise<TelegramUser> {
    const user = await this.repo.findOneBy({ id });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findByIdOrNull(id: string): Promise<TelegramUser | null> {
    return this.repo.findOneBy({ id });
  }

  async setBlocked(id: string, is_blocked: boolean): Promise<void> {
    await this.repo.update({ id }, { is_blocked });
  }

  /** Admin panel list — search across username/name/telegram id + per-user ticket counts (no N+1). */
  async listUsers(params: {
    q?: string;
    page: number;
    limit: number;
  }): Promise<Paginated<UserWithTicketCount>> {
    const { q, page, limit } = params;
    const qb = this.repo
      .createQueryBuilder('u')
      .loadRelationCountAndMap('u.ticket_count', 'u.tickets', 'ticket_count');

    if (q) {
      const like = `%${escapeLike(q.trim())}%`;
      qb.andWhere(
        new Brackets((b) => {
          b.where('u.username ILIKE :like')
            .orWhere('u.first_name ILIKE :like')
            .orWhere('u.last_name ILIKE :like')
            .orWhere('CAST(u.telegram_id AS TEXT) ILIKE :like');
        }),
        { like },
      );
    }

    const [items, total] = await qb
      .orderBy('u.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return toPaginated(items as UserWithTicketCount[], total, page, limit);
  }

  async getUserWithTickets(id: string): Promise<TelegramUser | null> {
    return this.repo.findOne({
      where: { id },
      relations: { tickets: true },
      order: { tickets: { created_at: 'DESC' } },
    });
  }
}
