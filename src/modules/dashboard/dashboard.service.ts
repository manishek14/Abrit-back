import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { getEnv } from '../../config/env';

export interface DashboardStats {
  tickets: {
    total: number;
    open: number;
    inProgress: number;
    closed: number;
    today: number;
  };
  users: {
    total: number;
  };
  timezone: string;
  updatedAt: string;
}

@Injectable()
export class DashboardService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** One aggregate query for tickets (COUNT FILTER) + one for users; "today" honours APP_TIMEZONE. */
  async getStats(): Promise<DashboardStats> {
    const env = getEnv();
    const tz = env.APP_TIMEZONE;

    const tickets = await this.dataSource.query(
      `SELECT
         (count(*))::int AS total,
         (count(*) FILTER (WHERE status = 'OPEN'))::int AS open,
         (count(*) FILTER (WHERE status = 'IN_PROGRESS'))::int AS in_progress,
         (count(*) FILTER (WHERE status = 'CLOSED'))::int AS closed,
         (count(*) FILTER (WHERE created_at >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)))::int AS today
       FROM tickets`,
      [tz],
    );
    const users = await this.dataSource.query(
      `SELECT (count(*))::int AS total FROM telegram_users`,
    );

    const t = tickets[0] ?? { total: 0, open: 0, in_progress: 0, closed: 0, today: 0 };
    return {
      tickets: {
        total: Number(t.total),
        open: Number(t.open),
        inProgress: Number(t.in_progress),
        closed: Number(t.closed),
        today: Number(t.today),
      },
      users: { total: Number(users[0]?.total ?? 0) },
      timezone: tz,
      updatedAt: new Date().toISOString(),
    };
  }
}
