import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { TicketsService } from './tickets.service';
import { MessagesService } from '../messages/messages.service';
import { ListTicketsQueryDto } from './dto/list-tickets-query.dto';
import { UpdateTicketStatusDto } from './dto/update-ticket-status.dto';

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
  @Max(1000)
  limit?: number;
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
   *   ?after=<id>  — incremental refresh (newer than the cursor)
   *   ?before=<id> — one older page (for the panel's "load older" button)
   *   ?limit=1..1000 — page size (default 1000)
   * The response carries meta.has_more = older messages exist beyond this page.
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
}
