import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { parse as parseConn } from 'pg-connection-string';
import { getEnv } from './env';

/**
 * TypeORM options built from DATABASE_URL. `synchronize` is ALWAYS false —
 * schema changes go through explicit migrations only.
 */
export function buildTypeOrmOptions(): TypeOrmModuleOptions {
  const env = getEnv();
  const c = parseConn(env.DATABASE_URL);

  return {
    type: 'postgres',
    // `||` (not ??) — pg-connection-string returns empty strings for missing parts.
    host: c.host || '127.0.0.1',
    port: Number(c.port || 5432),
    username: c.user || 'abrit',
    password: c.password || undefined,
    database: c.database || 'abrit',
    entities: [`${__dirname}/../database/entities/*{.js,.ts}`],
    migrations: [`${__dirname}/../database/migrations/*{.js,.ts}`],
    // Auto-run pending migrations on boot (idempotent, evaluator-friendly);
    // controllable via env — the app can also be migrated with `npm run migration:run`.
    migrationsRun: env.MIGRATIONS_RUN,
    synchronize: false,
    logging: false,
    maxQueryExecutionTime: 2000,
  };
}
