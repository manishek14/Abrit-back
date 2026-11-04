import { Module } from '@nestjs/common';
import { getEnv } from '../../config/env';
import { InboxModule } from '../inbox/inbox.module';
import { MessagesModule } from '../messages/messages.module';
import { TicketsModule } from '../tickets/tickets.module';
import { UsersModule } from '../users/users.module';
import { ConversationModule } from '../conversation/conversation.module';
import { IngestService } from './ingest.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import { SweeperService } from './sweeper.service';
import { TelegramCoreModule } from './telegram-core.module';
import { TELEGRAM_WEBHOOK_SECRET, TelegramWebhookController } from './telegram-webhook.controller';

/**
 * Telegram integration layer. While TELEGRAM_BOT_TOKEN is empty the transport
 * is the InactiveGateway — everything else (inbox, orchestrator, dispatcher,
 * sweeper, webhook endpoint with secret) is fully functional and covered by tests.
 */
@Module({
  imports: [
    TelegramCoreModule,
    ConversationModule,
    InboxModule,
    UsersModule,
    TicketsModule,
    MessagesModule,
  ],
  controllers: [TelegramWebhookController],
  providers: [
    { provide: TELEGRAM_WEBHOOK_SECRET, useFactory: () => getEnv().TELEGRAM_WEBHOOK_SECRET },
    IngestService,
    OutboxDispatcherService,
    SweeperService,
  ],
})
export class TelegramModule {}
