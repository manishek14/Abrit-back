import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { parseEnv } from './config/env';
import { buildTypeOrmOptions } from './config/typeorm.config';
import { DatabaseInitService } from './database/database-init.service';
import { EventsModule } from './common/events/events.module';
import { HealthModule } from './modules/health/health.module';
import { UsersModule } from './modules/users/users.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { MessagesModule } from './modules/messages/messages.module';
import { InboxModule } from './modules/inbox/inbox.module';
import { AiModule } from './modules/ai/ai.module';
import { ConversationModule } from './modules/conversation/conversation.module';
import { TelegramModule } from './modules/telegram/telegram.module';

@Module({
  imports: [
    // Fail fast: the process refuses to boot with an invalid/missing env config.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../.env'],
      validate: (raw) =>
        parseEnv(raw as Record<string, string | undefined>) as unknown as Record<string, unknown>,
    }),
    TypeOrmModule.forRootAsync({
      useFactory: () => buildTypeOrmOptions(),
    }),
    ScheduleModule.forRoot(),
    EventsModule,
    UsersModule,
    TicketsModule,
    MessagesModule,
    InboxModule,
    AiModule,
    ConversationModule,
    TelegramModule,
    HealthModule,
  ],
  providers: [DatabaseInitService],
})
export class AppModule {}
