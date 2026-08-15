import type { PageRequest, PageSlice } from "@ansa/db";

import { integer, list, object, optional, type Infer, type Schema } from "./schema";

/**
 * The one pagination contract every list endpoint uses.
 *
 * `?page=&perPage=` in, `{ items, page, perPage, total, totalPages }` out. Page numbers
 * rather than an opaque cursor, which is a deliberate trade and worth stating because it
 * shows up in real use: these lists are newest-first and constantly written to, so a call
 * arriving between one page view and the next shifts every row down and a reader can see
 * the same row twice. A cursor never did that. What a cursor could never do is say how
 * many there are or take you to page four, and for a person reading a call log that is
 * worth more than the duplicate.
 *
 * Pages are 1-based because they are shown to people. Page zero is not a smaller page
 * one, it is a mistake, and it is rejected rather than quietly clamped.
 */

export const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * The two properties every list takes, as properties rather than a finished schema.
 *
 * A list with filters spreads these into its own query object — `object({ ...PAGE_PROPS,
 * from: … })` — so the ceiling on `perPage` is written once. Declaring them again beside
 * the filters is how one endpoint quietly ends up accepting `perPage=5000`.
 */
export const PAGE_PROPS = {
  page: optional(integer({ minimum: 1 })),
  perPage: optional(integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
};

export const pageQuery = object(PAGE_PROPS);

export type PageQuery = Infer<typeof pageQuery>;

export const toPageRequest = (query: PageQuery): PageRequest => {
  const perPage = query.perPage ?? DEFAULT_PAGE_SIZE;
  const page = query.page ?? 1;
  return { limit: perPage, offset: (page - 1) * perPage };
};

/** The response schema for a list of `item`. Declared per endpoint so the item type shows up in the spec. */
export const pageResponse = <T>(item: Schema<T>) =>
  object({
    items: list(item),
    /** 1-based, echoed back so a client never has to remember what it asked for. */
    page: integer({ minimum: 1 }),
    perPage: integer({ minimum: 1 }),
    /** Rows matching the query across every page. */
    total: integer({ minimum: 0 }),
    /** Zero when there is nothing at all — not one empty page. */
    totalPages: integer({ minimum: 0 }),
  });

export interface PageBody<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly perPage: number;
  readonly total: number;
  readonly totalPages: number;
}

export const toPageBody = <T>(slice: PageSlice<T>, query: PageQuery): PageBody<T> => {
  const perPage = query.perPage ?? DEFAULT_PAGE_SIZE;
  return {
    items: slice.items,
    page: query.page ?? 1,
    perPage,
    total: slice.total,
    totalPages: Math.ceil(slice.total / perPage),
  };
};
