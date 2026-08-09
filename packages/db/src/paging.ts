/**
 * Keyset pagination, shared by every list the dashboard serves.
 *
 * Keyset rather than offset because these lists are ordered newest-first and are written
 * to constantly. With `limit/offset`, a call arriving between page one and page two
 * shifts every row down and the reader sees a duplicate; with a keyset the second page
 * starts exactly where the first ended regardless of what happened in between.
 *
 * The cursor is `(created_at, id)` — the timestamp for the order and the id to break ties
 * between rows created in the same microsecond, which is not hypothetical when a call
 * writes several rows at once.
 */

export interface PageCursor {
  /** ISO 8601, as it came out of Postgres. */
  readonly createdAt: string;
  /** Whatever uniquely identifies the row within one timestamp. */
  readonly id: string;
}

export interface PageRequest {
  readonly limit: number;
  /** Null on the first page. */
  readonly after: PageCursor | null;
}

export interface PageSlice<T> {
  readonly items: readonly T[];
  /** Null when this was the last page. */
  readonly next: PageCursor | null;
}

/**
 * SQL fragment shared by every keyset query, so the comparison is written once.
 *
 * `($2::timestamptz is null or (created_at, id) < ($2, $3))` is a row comparison, not
 * two column comparisons joined by AND — those are not the same thing and the second is
 * subtly wrong at a tie. Callers bind $1 = limit + 1, $2 = cursor timestamp, $3 = cursor
 * id, and pass their own column names because the id column differs per table.
 */
export const keysetWhere = (createdAt: string, id: string): string =>
  `($2::timestamptz is null or (${createdAt}, ${id}::text) < ($2::timestamptz, $3::text))`;

/** The `order by … limit` half, matching `keysetWhere`. */
export const keysetOrder = (createdAt: string, id: string): string =>
  `order by ${createdAt} desc, ${id} desc limit $1`;

/** Parameters for the two fragments above. One extra row is fetched to detect a next page. */
export const keysetParams = (page: PageRequest): readonly unknown[] => [
  page.limit + 1,
  page.after?.createdAt ?? null,
  page.after?.id ?? null,
];

/**
 * Trims the sentinel row off and turns it into a cursor.
 *
 * The accessor exists because the tiebreaker column is not called `id` on every table —
 * `memberships` is keyed by `(tenant_id, user_id)` and has no id at all.
 */
export const toSlice = <T>(
  rows: readonly T[],
  page: PageRequest,
  cursorOf: (row: T) => PageCursor,
): PageSlice<T> => {
  if (rows.length <= page.limit) return { items: rows, next: null };
  const items = rows.slice(0, page.limit);
  const last = items[items.length - 1];
  return { items, next: last === undefined ? null : cursorOf(last) };
};
