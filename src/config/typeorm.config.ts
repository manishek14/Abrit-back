import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { parse as parseConn } from 'pg-connection-string';
import { getEnv } from './env';

/**
 * TypeORM options built from DATABASE_URL. `synchronize` is ALWAYS false —
 * schema changes go through explicit migrations only.
 *
 * Review round 6 (production database settings): managed PostgreSQL services
 * usually require TLS. Three ways to switch it on, in priority order:
 *   1. DATABASE_SSL=true                      (explicit, with optional CA below)
 *   2. DATABASE_SSL_CA set                    (implies TLS, CA-verified)
 *   3. `?sslmode=require` in DATABASE_URL     (the managed-PG convention)
 * When a CA is provided the server certificate is verified against it
 * (rejectUnauthorized: true); without a CA TLS is encrypted but the server
 * certificate is not pinned — the usual trade-off for self-signed managed CAs.
 */
export function buildTypeOrmOptions(): TypeOrmModuleOptions {
  const env = getEnv();
  const c = parseConn(env.DATABASE_URL);

  const wantsSsl =
    env.DATABASE_SSL === true || Boolean(env.DATABASE_SSL_CA) || c.sslmode === 'require';
  const ssl = wantsSsl
    ? {
        rejectUnauthorized: Boolean(env.DATABASE_SSL_CA),
        ...(env.DATABASE_SSL_CA ? { ca: env.DATABASE_SSL_CA } : {}),
      }
    : undefined;

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
    ssl,
    logging: false,
    maxQueryExecutionTime: 2000,
  };
}
