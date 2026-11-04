export interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number };
}

export const MAX_PAGE_LIMIT = 100;

export function toPaginated<T>(data: T[], total: number, page: number, limit: number): Paginated<T> {
  return { data, meta: { page, limit, total } };
}

/** Escape LIKE/ILIKE wildcards so user input can't widen the match. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
