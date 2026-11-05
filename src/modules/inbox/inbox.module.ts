import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotUpdate } from '../../database/entities/bot-update.entity';
import { InboxService } from './inbox.service';
import { InboxRetentionService } from './inbox-retention.service';

@Module({
  imports: [TypeOrmModule.forFeature([BotUpdate])],
  providers: [InboxService, InboxRetentionService],
  exports: [InboxService],
})
export class InboxModule {}
