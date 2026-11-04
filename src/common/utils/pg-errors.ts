/** PostgreSQL error-code helpers (see https://www.postgresql.org/docs/current/errcodes-appendix.html). */

export function getDbErrorCode(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** 23505 — e.g. partial unique index "one active ticket per user" or a duplicate update_id. */
export function isUniqueViolation(e: unknown): boolean {
  return getDbErrorCode(e) === '23505';
}

/** 23503 — foreign key violation. */
export function isForeignKeyViolation(e: unknown): boolean {
  return getDbErrorCode(e) === '23503';
}
