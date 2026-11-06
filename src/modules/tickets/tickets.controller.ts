import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { TicketsService } from './tickets.service';
import { MessagesService, MAX_PAGE_SIZE } from '../messages/messages.service';
import { ListTicketsQueryDto } from './dto/list-tickets-query.dto';
import { UpdateTicketStatusDto } from './dto/update-ticket-status.dto';
import { CurrentAdmin, CurrentAdminPayload } from '../../common/decorators/current-admin.decorator';
import { TicketStatus } from '../../database/enums';

/** PostgreSQL bigint identities max out at 2^63-1 → at most 19 digits. */
export const MESSAGE_ID_CURSOR_REGEX = /^\d{1,19}$/;

export class TicketMessagesQueryDto {
  /** Incremental refresh: return messages newer than this id. */
  @IsOptional()
  @IsString()
  @MaxLength(19)
  @Matches(MESSAGE_ID_CURSOR_REGEX, {
    message: 'after must be a numeric message id (max 19 digits, PostgreSQL bigint)',
  })
  after?: string;

  /** Backward pagination: return the `limit` messages older than this id. */
  @IsOptional()
  @IsString()
  @MaxLength(19)
  @Matches(MESSAGE_ID_CURSOR_REGEX, {
    message: 'before must be a numeric message id (max 19 digits, PostgreSQL bigint)',
  })
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

export class CreateTicketMessageDto {
  @IsString()
  @IsNotEmpty({ message: 'Message content is required' })
  @MaxLength(MAX_ADMIN_MESSAGE_LENGTH, {
    message: `Message content must be at most ${MAX_ADMIN_MESSAGE_LENGTH} characters`,
  })
  content!: string;
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
   */
  @Post(':id/messages')
  async postMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTicketMessageDto,
    @CurrentAdmin() admin: CurrentAdminPayload,
  ) {
    const ticket = await this.ticketsService.findById(id);
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.status === TicketStatus.CLOSED) {
      throw new ConflictException('Ticket is closed — reopen it to reply');
    }
    const message = await this.messagesService.addAdminMessage({
      ticket_id: id,
      content: dto.content.trim(),
      admin_id: admin.sub,
    });
    return { data: message };
  }
}
