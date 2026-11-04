import { IsIn } from 'class-validator';
import { TicketStatus } from '../../../database/enums';

export class UpdateTicketStatusDto {
  @IsIn([TicketStatus.OPEN, TicketStatus.IN_PROGRESS, TicketStatus.CLOSED])
  status!: TicketStatus;
}
