import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min, Validate } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import type { Response } from 'express';
import { TicketsService } from './tickets.service';
import { MessagesService, MAX_PAGE_SIZE } from '../messages/messages.service';
import { ListTicketsQueryDto } from './dto/list-tickets-query.dto';
import { UpdateTicketStatusDto } from './dto/update-ticket-status.dto';
import { CurrentAdmin, CurrentAdminPayload } from '../../common/decorators/current-admin.decorator';
import { IsMessageIdCursorConstraint } from '../../common/validators/message-id-cursor.validator';

/**
 * Conversation history, ordered and cursor-paginated:
 *   (no cursor)  — the LATEST `limit` messages (default 50): agents always
 *                  land on the newest state of the conversation.
 *   ?after=<id>   — incremental refresh (newer than the cursor)
 *   ?before=<id>  — one older page (for the panel's "load older" button)
 *   ?limit=1..1000 — page size (default 50)
 * meta.has_more reports whether MORE messages exist beyond the page in the
 * direction of travel (older for initial/before pages, newer for after).
 */
export class TicketMessagesQueryDto {
  /** Incremental refresh: return messages newer than this id. */
  @IsOptional()
  @IsString()
  @Validate(IsMessageIdCursorConstraint)
  after?: string;

  /** Backward pagination: return the `limit` messages older than this id. */
  @IsOptional()
  @IsString()
  @Validate(IsMessageIdCursorConstraint)
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}

/** Admin replies are chunked to Telegram's 4096-char hard limit by the dispatcher. */
const MAX_ADMIN_MESSAGE_LENGTH = 4000;

/** Idempotency keys: url-safe, generated per send attempt by the panel. */
const CLIENT_MESSAGE_ID_REGEX = /^[A-Za-z0-9_-]{8,64}$/;

export class CreateTicketMessageDto {
  /**
   * Trimmed BEFORE validation (review fix): whitespace-only drafts ("     ")
   * must be rejected with 400 here — previously they passed @IsNotEmpty and
   * were stored as empty strings after the controller's trim().
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Message content must be a string' })
  @IsNotEmpty({ message: 'Message content is required' })
  @MaxLength(MAX_ADMIN_MESSAGE_LENGTH, {
    message: `Message content must be at most ${MAX_ADMIN_MESSAGE_LENGTH} characters`,
  })
  content!: string;

  /**
   * Idempotency key (review fix): the panel generates one per send and REUSES
   * it on retry, so a lost HTTP response can never produce a duplicated reply
   * to the user — the server returns the original message instead.
   */
  @IsOptional()
  @IsString()
  @Matches(CLIENT_MESSAGE_ID_REGEX, {
    message: 'client_message_id must be 8-64 letters, digits, hyphens or underscores',
  })
  client_message_id?: string;
}

@Controller('tickets')
@ApiTags('tickets')
@ApiBearerAuth()
export class TicketsController {
  constructor(
    private readonly ticketsService: TicketsService,
    private readonly messagesService: MessagesService,
  ) {}

  @Get()
  async listTickets(@Query() query: ListTicketsQueryDto) {
    return this.ticketsService.listTickets({
      status: query.status,
      q: query.q,
      page: query.page,
      limit: query.limit,
    });
  }

  @Get(':id')
  async getTicket(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.ticketsService.getTicketWithUser(id) };
  }

  @Patch(':id/status')
  async changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTicketStatusDto,
  ) {
    const result = await this.ticketsService.changeStatus(id, dto.status, 'ADMIN');
    return { data: result };
  }

  @Get(':id/messages')
  async getMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TicketMessagesQueryDto,
  ) {
    if (query.after && query.before) {
      throw new BadRequestException('Pass either after or before, not both');
    }
    const ticket = await this.ticketsService.findById(id);
    if (!ticket) throw new NotFoundException('Ticket not found');
    const page = await this.messagesService.getConversationPage(id, {
      after: query.after,
      before: query.before,
      limit: query.limit,
    });
    return { data: page.messages, meta: { has_more: page.has_more } };
  }

  /**
   * Operator reply (review fix #4): stores an ADMIN message with the replying
   * admin's id, then the durable outbox delivers it to the user's Telegram
   * chat. The panel's delivery badge follows via realtime message:updated
   * events. Closed tickets refuse new replies with 409 — reopen first.
   *
   * Race-safe + idempotent (review fix): the open-ticket check, the lock and
   * the insert all live in ONE transaction (MessagesService.addAdminMessage)
   * — this controller deliberately does NOT pre-check the status, because a
   * read outside the transaction would be the exact race window. A replayed
   * client_message_id answers with the ORIGINAL message and HTTP 200.
   */
  @Post(':id/messages')
  async postMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTicketMessageDto,
    @CurrentAdmin() admin: CurrentAdminPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { message, replayed } = await this.messagesService.addAdminMessage({
      ticket_id: id,
      content: dto.content, // already trimmed by the DTO transform
      admin_id: admin.sub,
      client_message_id: dto.client_message_id ?? null,
    });
    if (replayed) res.status(HttpStatus.OK); // idempotent replay — not a new create
    return { data: message };
  }
}
