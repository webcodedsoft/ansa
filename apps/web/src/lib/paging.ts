/**
 * Reading page state out of a URL, once, for every list in the app.
 *
 * Both values arrive as strings somebody can type anything into, so neither is trusted:
 * anything that is not a sane number falls back to the default rather than reaching the API
 * or crashing the page. `perPage` is additionally checked against the sizes actually
 * offered — the API caps it at 100, but a reader who lands on `?perPage=97` sees a select
 * with no matching option, which looks broken even though nothing is.
 *
 * This lives outside the pagination component because Server Components read it, and every
 * export of a `"use client"` module is a client reference when the server imports it.
 */

/**
 * The sizes offered in the selector. Ordered; the first is the default.
 *
 * Ten rather than twenty-five, because a call log is read row by row and a page
 * that runs past the fold makes the pager itself something you have to go looking
 * for. The longer sizes are there for the other use — scanning for one call —
 * which is exactly the choice the selector exists to hand over.
 */
export const PAGE_SIZES = [10, 25, 50, 100] as const;

/** Annotated `number` deliberately: `as const` above would otherwise narrow this to the
 *  literal `25`, and a default parameter typed `25` rejects every other size. */
export const DEFAULT_PAGE_SIZE: number = PAGE_SIZES[0];

export interface Paging {
  /** 1-based, as the API counts them. */
  readonly page: number;
  readonly perPage: number;
}

const positiveInteger = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
};

export const readPaging = (search: {
  readonly page?: string;
  readonly perPage?: string;
}): Paging => {
  const size = positiveInteger(search.perPage);
  return {
    page: positiveInteger(search.page) ?? 1,
    perPage:
      size !== null && (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  };
};
