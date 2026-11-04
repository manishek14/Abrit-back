/**
 * Domain enums. PostgreSQL enum types are created once in the initial migration;
 * adding/removing values later requires a manual migration — so define them
 * completely from day one (per the execution plan).
 */
export enum TicketStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  CLOSED = 'CLOSED',
}

export enum MessageRole {
  USER = 'USER',
  ASSISTANT = 'ASSISTANT',
  ADMIN = 'ADMIN',
  SYSTEM = 'SYSTEM',
}

export enum DeliveryStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
}

export enum BotUpdateStatus {
  RECEIVED = 'RECEIVED',
  PROCESSING = 'PROCESSING',
  DONE = 'DONE',
  FAILED = 'FAILED',
}
