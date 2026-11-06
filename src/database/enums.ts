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

/**
 * Ticket departments chosen in the registration wizard (feature round:
 * عنوان → دپارتمان → متن). Stored as varchar + CHECK in the migration, so the
 * Persian labels live ONLY here and in the keyboard factory.
 */
export enum TicketDepartment {
  FINANCE = 'FINANCE',
  SUPPORT = 'SUPPORT',
  TECHNICAL = 'TECHNICAL',
  SUGGESTIONS = 'SUGGESTIONS',
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

/**
 * Processing milestones inside a single update's run (review fix #1). Stored on
 * bot_updates.stage; combined with idempotent steps this makes a re-run resume
 * half-finished work instead of dropping it.
 */
export enum BotUpdateStage {
  CLAIMED = 'CLAIMED',
  USER_SAVED = 'USER_SAVED',
  REPLY_SAVED = 'REPLY_SAVED',
}
