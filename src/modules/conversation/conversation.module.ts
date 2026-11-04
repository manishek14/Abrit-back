import { Module } from '@nestjs/common';
import { InboxModule } from '../inbox/inbox.module';
import { MessagesModule } from '../messages/messages.module';
import { TicketsModule } from '../tickets/tickets.module';
import { UsersModule } from '../users/users.module';
import { AiModule } from '../ai/ai.module';
import { TelegramCoreModule } from '../telegram/telegram-core.module';
import { CommandsService } from './commands.service';
import { OrchestratorService } from './orchestrator.service';

@Module({
  imports: [InboxModule, UsersModule, TicketsModule, MessagesModule, AiModule, TelegramCoreModule],
  providers: [CommandsService, OrchestratorService],
  exports: [OrchestratorService],
})
export class ConversationModule {}
