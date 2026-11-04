import {
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
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { TicketsService } from './tickets.service';
import { MessagesService } from '../messages/messages.service';
import { ListTicketsQueryDto } from './dto/list-tickets-query.dto';
import { UpdateTicketStatusDto } from './dto/update-ticket-status.dto';

export class TicketMessagesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  after?: string;
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

  /** Conversation history, ordered; `after` enables cheap incremental refresh. */
  @Get(':id/messages')
  async getMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TicketMessagesQueryDto,
  ) {
    const ticket = await this.ticketsService.findById(id);
    if (!ticket) throw new NotFoundException('Ticket not found');
    const messages = await this.messagesService.getConversation(id, {
      after: query.after,
    });
    return { data: messages };
  }
}
