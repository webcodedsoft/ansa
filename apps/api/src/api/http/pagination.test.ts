import type { PageSlice } from "@ansa/db";
import { describe, expect, it } from "vitest";

import { DEFAULT_PAGE_SIZE, toPageBody, toPageRequest } from "./pagination";

interface Row {
  readonly id: string;
}

const slice = (total: number): PageSlice<Row> => ({ items: [{ id: "a" }], total });

/**
 * Page numbers are 1-based because people read them, and offsets are 0-based because
 * Postgres does. Every off-by-one this contract can have lives in that conversion, so it
 * is the thing worth pinning down.
 */
describe("page numbers", () => {
  it("turn into offsets, with page one starting at nothing skipped", () => {
    expect(toPageRequest({ page: 1, perPage: 25 })).toEqual({ limit: 25, offset: 0 });
    expect(toPageRequest({ page: 2, perPage: 25 })).toEqual({ limit: 25, offset: 25 });
    expect(toPageRequest({ page: 4, perPage: 10 })).toEqual({ limit: 10, offset: 30 });
  });

  it("default rather than fetching everything", () => {
    expect(toPageRequest({})).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
  });

  it("echo what was asked for, so a client never has to remember", () => {
    const body = toPageBody(slice(120), { page: 3, perPage: 20 });
    expect(body.page).toBe(3);
    expect(body.perPage).toBe(20);
    expect(body.total).toBe(120);
  });

  it("round the page count up, because a partial page is still a page", () => {
    expect(toPageBody(slice(101), { perPage: 25 }).totalPages).toBe(5);
    expect(toPageBody(slice(100), { perPage: 25 }).totalPages).toBe(4);
  });

  /** Nothing at all is zero pages, not one empty one — there is nothing to page through. */
  it("report no pages when there is nothing", () => {
    expect(toPageBody({ items: [], total: 0 }, {}).totalPages).toBe(0);
  });
});
