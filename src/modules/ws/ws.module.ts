import { Module } from '@nestjs/common';
import { AdminEventsGateway } from './admin-events.gateway';
import { RealtimeBroadcastService } from './realtime-broadcast.service';

@Module({
  providers: [AdminEventsGateway, RealtimeBroadcastService],
})
export class WsModule {}
