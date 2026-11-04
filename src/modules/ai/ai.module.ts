import { Module } from '@nestjs/common';
import { getEnv } from '../../config/env';
import { MessagesModule } from '../messages/messages.module';
import { SettingsModule } from '../settings/settings.module';
import { ContextBuilderService } from './context-builder.service';
import { AiReplyProvider } from './ai-reply.provider';
import { AI_PROVIDER, AiProvider } from './ai-provider.interface';
import { OpenRouterProvider } from './openrouter.provider';
import { REPLY_PROVIDER } from './reply-provider.interface';

/**
 * The AI seam. The real OpenRouter provider is always bound here — whether a
 * call actually happens is decided at runtime by AiReplyProvider (settings +
 * key presence), so enabling the integration later is purely a config change.
 */
@Module({
  imports: [SettingsModule, MessagesModule],
  providers: [
    { provide: AI_PROVIDER, useFactory: (): AiProvider => new OpenRouterProvider(getEnv()) },
    ContextBuilderService,
    AiReplyProvider,
    { provide: REPLY_PROVIDER, useExisting: AiReplyProvider },
  ],
  exports: [REPLY_PROVIDER],
})
export class AiModule {}
