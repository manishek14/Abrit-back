import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotUpdate } from '../../database/entities/bot-update.entity';
import { InboxService } from './inbox.service';

@Module({
  imports: [TypeOrmModule.forFeature([BotUpdate])],
  providers: [InboxService],
  exports: [InboxService],
})
export class InboxModule {}
