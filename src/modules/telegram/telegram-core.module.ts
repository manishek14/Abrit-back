import { Module } from '@nestjs/common';
import { getEnv } from '../../config/env';
import { InactiveGateway } from './inactive.gateway';
import { TelegrafGateway } from './telegraf.gateway';
import { TELEGRAM_GATEWAY, TelegramGateway } from './telegram-gateway.interface';

/**
 * Gateway selection happens in ONE place: token present → real Telegraf
 * transport; token empty (current state) → inactive gateway. Swapping is a
 * configuration change, never a code change.
 */
@Module({
  providers: [
    {
      provide: TELEGRAM_GATEWAY,
      useFactory: (): TelegramGateway => {
        const env = getEnv();
        return env.TELEGRAM_BOT_TOKEN ? new TelegrafGateway(env) : new InactiveGateway();
      },
    },
  ],
  exports: [TELEGRAM_GATEWAY],
})
export class TelegramCoreModule {}
