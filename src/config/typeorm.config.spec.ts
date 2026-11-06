import { buildTypeOrmOptions } from './typeorm.config';
import { parseEnv } from './env';
import { setTestEnv } from '../common/testing/test-env';

/**
 * Review round 6 (production database settings): a real deployment may point
 * at a MANAGED PostgreSQL that requires TLS. The connection now supports
 *  - `DATABASE_SSL=true`                     → TLS, CA-verified when a CA is given
 *  - `DATABASE_SSL_CA` (PEM)                 → certificate pinning against the managed CA
 *  - `?sslmode=require` inside DATABASE_URL  → the de-facto managed-PG convention
 * Local/docker deployments keep working unchanged (no SSL by default).
 *
 * buildTypeOrmOptions() reads getEnv() → process.env, so every case pins the
 * environment through setTestEnv BEFORE the options are built.
 */
describe('typeorm SSL configuration (round 6)', () => {
  it('has NO ssl block by default (local docker/development stays unchanged)', () => {
    setTestEnv({
      DATABASE_URL: 'postgres://abrit:abrit@127.0.0.1:5432/abrit',
      DATABASE_SSL: '',
      DATABASE_SSL_CA: '',
    });
    delete process.env.DATABASE_SSL;
    delete process.env.DATABASE_SSL_CA;

    const options = buildTypeOrmOptions() as Record<string, unknown>;
    expect(options.ssl).toBeUndefined();
  });

  it('enables TLS when DATABASE_SSL=true', () => {
    setTestEnv({
      DATABASE_URL: 'postgres://abrit:abrit@db.internal:5432/abrit',
      DATABASE_SSL: 'true',
    });
    delete process.env.DATABASE_SSL_CA;

    const options = buildTypeOrmOptions() as Record<string, unknown>;
    expect(options.ssl).toMatchObject({ rejectUnauthorized: false });
  });

  it('uses the provided CA and verifies the server certificate against it', () => {
    setTestEnv({
      DATABASE_URL: 'postgres://abrit:abrit@db.internal:5432/abrit',
      DATABASE_SSL: 'true',
      DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    });

    const options = buildTypeOrmOptions() as Record<string, unknown>;
    expect(options.ssl).toMatchObject({
      rejectUnauthorized: true,
      ca: expect.stringContaining('BEGIN CERTIFICATE'),
    });
  });

  it('honours sslmode=require inside DATABASE_URL (managed-PG convention)', () => {
    setTestEnv({
      DATABASE_URL: 'postgres://abrit:abrit@db.internal:5432/abrit?sslmode=require',
    });
    delete process.env.DATABASE_SSL;
    delete process.env.DATABASE_SSL_CA;

    const options = buildTypeOrmOptions() as Record<string, unknown>;
    expect(options.ssl).toMatchObject({ rejectUnauthorized: false });
  });

  it('sslmode=disable keeps TLS off even with a bare URL', () => {
    setTestEnv({
      DATABASE_URL: 'postgres://abrit:abrit@127.0.0.1:5432/abrit?sslmode=disable',
    });
    delete process.env.DATABASE_SSL;
    delete process.env.DATABASE_SSL_CA;

    const options = buildTypeOrmOptions() as Record<string, unknown>;
    expect(options.ssl).toBeUndefined();
  });

  it('parseEnv keeps DATABASE_SSL optional and boolean-typed', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgres://abrit@127.0.0.1:5432/abrit',
      JWT_SECRET: 'unit-test-secret-value-0123456789',
      DATABASE_SSL: 'true',
    } as Record<string, string>);
    expect(env.DATABASE_SSL).toBe(true);
  });
});
