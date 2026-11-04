import 'reflect-metadata';
import { resolve } from 'path';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { parse as parseConn } from 'pg-connection-string';
import { parseEnv } from '../config/env';

/**
 * Standalone DataSource for the TypeORM CLI (`npm run migration:run` etc.).
 * It loads .env manually because no NestJS ConfigModule runs in CLI mode.
 */
for (const p of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../.env')]) {
  dotenv.config({ path: p });
}

const env = parseEnv(process.env as unknown as Record<string, string | undefined>);
const c = parseConn(env.DATABASE_URL);

export default new DataSource({
  type: 'postgres',
  // `||` (not ??) — pg-connection-string returns empty strings for missing parts.
  host: c.host || '127.0.0.1',
  port: Number(c.port || 5432),
  username: c.user || 'abrit',
  password: c.password || undefined,
  database: c.database || 'abrit',
  entities: [`${__dirname}/entities/*{.js,.ts}`],
  migrations: [`${__dirname}/migrations/*{.js,.ts}`],
  migrationsRun: false,
  synchronize: false,
  logging: false,
});
