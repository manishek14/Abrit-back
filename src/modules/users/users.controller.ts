import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { UsersService } from './users.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListUsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  q?: string;
}

@Controller('users')
@ApiTags('users')
@ApiBearerAuth()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async listUsers(@Query() query: ListUsersQueryDto) {
    return this.usersService.listUsers({
      q: query.q,
      page: query.page,
      limit: query.limit,
    });
  }

  @Get(':id')
  async getUser(@Param('id') id: string) {
    const user = await this.usersService.getUserWithTickets(id);
    if (!user) throw new NotFoundException('User not found');
    return { data: user };
  }
}
