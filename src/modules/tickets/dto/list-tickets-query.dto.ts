import { IsIn, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { TicketStatus } from '../../../database/enums';

export class ListTicketsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn([TicketStatus.OPEN, TicketStatus.IN_PROGRESS, TicketStatus.CLOSED])
  status?: TicketStatus;

  @IsOptional()
  @IsString()
  q?: string;
}
