/**
 * TypeORM's raw `repo.query()` returns UPDATE…RETURNING results nested one
 * level ([ [row] ]) while INSERT…RETURNING comes back flat ([row]) — this
 * helper normalizes both shapes into a single row (or null when empty).
 */
export function firstRawRow<T>(rows: unknown): T | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0];
  if (Array.isArray(first)) return (first[0] as T) ?? null;
  return (first as T) ?? null;
}
