import { EventEmitter } from 'node:events';
import { Injectable, Logger } from '@nestjs/common';
import { Ticket } from '../../database/entities/ticket.entity';
import { Message } from '../../database/entities/message.entity';
import { TelegramUser } from '../../database/entities/telegram-user.entity';
import { TicketStatus } from '../../database/enums';

/**
 * In-process domain events. Used today for the outbox dispatcher (send right
 * after commit) and the Socket.IO gateway — one broadcast, any number of
 * listeners, no DB coupling.
 */
export interface DomainEvents {
  'ticket.created': { ticket: Ticket };
  'ticket.status_changed': {
    ticket: Ticket;
    previousStatus: TicketStatus;
    systemMessage: Message | null;
  };
  'message.created': { message: Message };
  'message.updated': { message: Message };
  /** Fires only for FIRST-SEEN users so the panel's user list stays live
   *  (review fix) without refetching on every profile refresh. */
  'user.created': { user: TelegramUser };
}

export type DomainEventName = keyof DomainEvents;
type Handler<K extends DomainEventName> = (payload: DomainEvents[K]) => void | Promise<void>;

@Injectable()
export class EventsService {
  private readonly emitter = new EventEmitter();
  private readonly logger = new Logger('Events');

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  on<K extends DomainEventName>(event: K, handler: Handler<K>): () => void {
    const wrapped = (payload: DomainEvents[K]) => {
      try {
        void Promise.resolve(handler(payload)).catch((e) =>
          this.logger.error(`async handler failed for "${event}": ${(e as Error).message}`),
        );
      } catch (e) {
        this.logger.error(`handler failed for "${event}": ${(e as Error).message}`);
      }
    };
    this.emitter.on(event, wrapped as (...a: unknown[]) => void);
    return () => this.emitter.off(event, wrapped as (...a: unknown[]) => void);
  }

  emit<K extends DomainEventName>(event: K, payload: DomainEvents[K]): void {
    this.emitter.emit(event, payload);
  }
}
