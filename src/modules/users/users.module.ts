import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([TelegramUser])],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
