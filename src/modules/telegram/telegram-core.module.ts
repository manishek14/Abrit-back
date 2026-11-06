import { Module } from '@nestjs/common';
import { getEnv } from '../../config/env';
import { IntegrationStateService } from '../../common/integration-state/integration-state.service';
import { InactiveGateway } from './inactive.gateway';
import { TelegrafGateway } from './telegraf.gateway';
import { TELEGRAM_GATEWAY, TelegramGateway } from './telegram-gateway.interface';

/**
 * Gateway selection happens in ONE place: token present → real Telegraf
 * transport; token empty (current state) → inactive gateway. Swapping is a
 * configuration change, never a code change.
 *
 * Review round 6 fix #1: both branches report their lifecycle into the shared
 * IntegrationStateService so the readiness probe can tell "disabled" (no
 * token) apart from "degraded" (token set, but Telegram is unreachable).
 */
@Module({
  providers: [
    {
      provide: TELEGRAM_GATEWAY,
      useFactory: (state: IntegrationStateService): TelegramGateway => {
        const env = getEnv();
        if (env.TELEGRAM_BOT_TOKEN) {
          return new TelegrafGateway(env, state);
        }
        // Token intentionally empty: the integration is DISABLED, not broken.
        state.setTelegram('disabled');
        return new InactiveGateway();
      },
      inject: [IntegrationStateService],
    },
  ],
  exports: [TELEGRAM_GATEWAY],
})
export class TelegramCoreModule {}
