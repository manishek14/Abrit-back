import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { parseEnv } from './config/env';
import { buildTypeOrmOptions } from './config/typeorm.config';
import { DatabaseInitService } from './database/database-init.service';
import { EventsModule } from './common/events/events.module';
import { IntegrationStateModule } from './common/integration-state/integration-state.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { CsrfGuard } from './common/guards/csrf.guard';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { MessagesModule } from './modules/messages/messages.module';
import { InboxModule } from './modules/inbox/inbox.module';
import { AiModule } from './modules/ai/ai.module';
import { ConversationModule } from './modules/conversation/conversation.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { SettingsModule } from './modules/settings/settings.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { WsModule } from './modules/ws/ws.module';

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
    // mild global rate limit (per IP); login has a much stricter @Throttle
    ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }] }),
    IntegrationStateModule,
    EventsModule,
    AuthModule,
    UsersModule,
    TicketsModule,
    MessagesModule,
    InboxModule,
    AiModule,
    ConversationModule,
    TelegramModule,
    SettingsModule,
    DashboardModule,
    WsModule,
    HealthModule,
  ],
  providers: [
    DatabaseInitService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // AFTER the JWT guard (registration order): hardens cookie-authenticated
    // state-changing requests with the double-submit token (review round 6).
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule {}
