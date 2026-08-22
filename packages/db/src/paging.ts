/**
 * Page-numbered pagination, shared by every list the dashboard serves.
 *
 * `limit/offset` with a total, so a reader can see how many pages there are and jump to
 * one. That is a deliberate trade against the keyset this replaced, and the trade is worth
 * stating because it shows up in real use: these lists are newest-first and written to
 * constantly, so a call arriving between page one and page two shifts every row down by
 * one and the reader sees a row twice. A keyset never did that, but it also cannot answer
 * "how many" or "take me to page four", which is what a person reading a call log wants.
 *
 * The count comes from `count(*) over()` on the same query rather than a second round
 * trip, so the total is consistent with the rows beside it and costs one scan instead of
 * two. On a table large enough for that scan to hurt, the fix is a cheaper estimate, not
 * a second query — but nothing here is near that yet.
 */

export interface PageRequest {
  readonly limit: number;
  /** Rows to skip. Zero on the first page. */
  readonly offset: number;
}

export interface PageSlice<T> {
  readonly items: readonly T[];
  /** Rows matching the query across every page, not just this one. */
  readonly total: number;
}

/**
 * The `order by … limit … offset` tail every list query ends with.
 *
 * `id` is not decoration: ordering by a timestamp alone leaves rows created in the same
 * microsecond in an arbitrary order, and an arbitrary order under `offset` means a row can
 * appear on two pages or on none. Callers pass their own column names because the
 * tiebreaker is not called `id` on every table.
 *
 * `from` is where the two placeholders start, for a query that binds something of its own
 * first — a `where` clause on an agent id, say. It defaults to 1, which is every caller that
 * filters on nothing but RLS. Without it a filtered list has to pass its own parameters
 * *after* the limit and offset, which reads backwards from the query it is building and is
 * the kind of thing that binds a uuid to `limit` once and is never written again.
 */
export const pageOrder = (createdAt: string, id: string, from = 1): string =>
  `order by ${createdAt} desc, ${id} desc limit $${from} offset $${from + 1}`;

/** Selected alongside the row columns so the total travels with the page. */
export const TOTAL_COLUMN = "count(*) over() as total_rows";

/** Parameters for `pageOrder`, in that order. Bound at `from` and `from + 1`. */
export const pageParams = (page: PageRequest): readonly unknown[] => [page.limit, page.offset];

/** A row as returned by a query that selected `TOTAL_COLUMN`. */
export interface WithTotal {
  readonly total_rows: number | string;
}

/**
 * Turns raw rows into a mapped slice.
 *
 * Mapping happens here rather than at the call site because the total rides on every row
 * and would be thrown away by a mapper that ran first. The total is read off the first
 * row; an empty page has none to read, and is a total of zero by definition — there is
 * nothing to be on page two of.
 */
export const toSlice = <R extends WithTotal, T>(
  rows: readonly R[],
  map: (row: R) => T,
): PageSlice<T> => {
  const first = rows[0];
  return {
    items: rows.map(map),
    total: first === undefined ? 0 : Number(first.total_rows),
  };
};
