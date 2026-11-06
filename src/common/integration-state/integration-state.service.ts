import { Injectable } from '@nestjs/common';

/**
 * Lifecycle status of an external integration.
 *
 *  - disabled  — no credentials configured (feature intentionally off)
 *  - starting  — bootstrap in progress
 *  - ok        — last bootstrap/usage proved the integration works
 *  - degraded  — configured, but the last attempt FAILED (the review round 6
 *                P1: a broken Telegram token or an unreachable Telegram used to
 *                leave the app "healthy" while the bot was dead)
 */
export type IntegrationStatus = 'disabled' | 'starting' | 'ok' | 'degraded';

export interface IntegrationStateEntry {
  status: IntegrationStatus;
  /** Human-readable reason for the current status (empty when ok). */
  detail: string;
  /** ISO timestamp of the last transition into this status. */
  since: string;
}

export interface IntegrationStateSnapshot {
  telegram: IntegrationStateEntry;
  openRouter: IntegrationStateEntry;
}

const EMPTY = (status: IntegrationStatus): IntegrationStateEntry => ({
  status,
  detail: '',
  since: new Date().toISOString(),
});

/**
 * Single source of truth for "are the external integrations actually alive?".
 * The Telegram gateway reports its bootstrap result here and the AI reply
 * provider reports OpenRouter usage; the readiness probe reads the snapshot
 * and the panel can surface it. Plain in-memory state — with the documented
 * single-instance deployment this is exactly the process's own truth.
 */
@Injectable()
export class IntegrationStateService {
  private telegram: IntegrationStateEntry = EMPTY('disabled');
  private openRouter: IntegrationStateEntry = EMPTY('disabled');

  setTelegram(status: IntegrationStatus, detail = ''): void {
    this.telegram = { status, detail, since: new Date().toISOString() };
  }

  setOpenRouter(status: IntegrationStatus, detail = ''): void {
    this.openRouter = { status, detail, since: new Date().toISOString() };
  }

  snapshot(): IntegrationStateSnapshot {
    return { telegram: { ...this.telegram }, openRouter: { ...this.openRouter } };
  }
}
