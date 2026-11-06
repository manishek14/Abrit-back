import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Public } from '../../common/decorators/public.decorator';
import {
  IntegrationStateService,
  IntegrationStateSnapshot,
} from '../../common/integration-state/integration-state.service';

interface ReadinessBody {
  status: 'ok' | 'degraded' | 'error';
  db: 'up' | 'down';
  time: string;
  /** Round 6 fix #1: external integrations are REFLECTED here. */
  integrations: IntegrationStateSnapshot;
}

/**
 * Review round 6 fix #1 — Liveness vs Readiness:
 *
 *  GET /api/health/live   Liveness: "the process responds". No external
 *                         dependency is consulted — a dead Telegram or a
 *                         down database must NOT get the container killed
 *                         (the platform restarts on liveness failure only).
 *
 *  GET /api/health/ready  Readiness: "able to serve traffic". Requires the
 *                         database AND a working Telegram transport (when
 *                         one is configured). OpenRouter status is REPORTED
 *                         but a temporary AI outage does not take the API
 *                         out of service — the pipeline stores messages and
 *                         the honest fallback answers users.
 *
 *  GET /api/health        Legacy alias of readiness (kept for existing
 *                         dashboards/demo scripts; same body, same codes).
 */
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly integrations: IntegrationStateService,
  ) {}

  @Public()
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: string; time: string } {
    return { status: 'ok', time: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async ready(): Promise<ReadinessBody> {
    const integrations = this.integrations.snapshot();
    const time = new Date().toISOString();

    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        db: 'down',
        time,
        integrations,
      });
    }

    // A configured-but-broken Telegram transport means the core product (the
    // bot) is NOT working — the app must not be reported ready. 'starting' is
    // the normal boot window and stays ready; OpenRouter never gates readiness.
    if (integrations.telegram.status === 'degraded') {
      throw new ServiceUnavailableException({
        status: 'degraded',
        db: 'up',
        time,
        integrations,
      });
    }

    return { status: 'ok', db: 'up', time, integrations };
  }

  /** Legacy endpoint — same semantics as readiness. */
  @Public()
  @Get()
  @HttpCode(HttpStatus.OK)
  async check(): Promise<ReadinessBody> {
    return this.ready();
  }
}
