import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventsService } from '../../common/events/events.service';
import { AdminEventsGateway } from './admin-events.gateway';

/**
 * Bridges domain events → the WebSocket gateway, so the panel updates the very
 * moment a user opens a ticket or the AI answers on Telegram (owner's
 * requirement). Transport-agnostic: same events also drive the outbox
 * dispatcher — the WS side is purely additive.
 */
@Injectable()
export class RealtimeBroadcastService implements OnModuleInit {
  private readonly logger = new Logger('RealtimeBroadcast');

  constructor(
    private readonly events: EventsService,
    private readonly gateway: AdminEventsGateway,
  ) {}

  onModuleInit(): void {
    this.events.on('ticket.created', ({ ticket }) =>
      this.gateway.broadcast('ticket:new', { ticket }),
    );
    this.events.on('ticket.status_changed', ({ ticket, previousStatus }) =>
      this.gateway.broadcast('ticket:updated', { ticket, previousStatus }),
    );
    this.events.on('message.created', ({ message }) =>
      this.gateway.broadcast('message:new', { message }),
    );
    this.events.on('message.updated', ({ message }) =>
      this.gateway.broadcast('message:updated', { message }),
    );
    this.events.on('user.created', ({ user }) =>
      this.gateway.broadcast('user:new', { user }),
    );
    this.logger.log('domain events → websocket bridge active');
  }
}
