import { Module } from '@nestjs/common';
import { FixedReplyProvider } from './fixed-reply.provider';
import { REPLY_PROVIDER } from './reply-provider.interface';

@Module({
  providers: [{ provide: REPLY_PROVIDER, useClass: FixedReplyProvider }],
  exports: [REPLY_PROVIDER],
})
export class AiModule {}
