import type { PageSlice } from "@ansa/db";
import { describe, expect, it } from "vitest";

import { DEFAULT_PAGE_LIMIT, toPageBody, toPageRequest } from "./pagination";
import { ValidationFailed } from "./problem";

interface Row {
  readonly id: string;
  readonly createdAt: string;
}

const slice = (next: { createdAt: string; id: string } | null): PageSlice<Row> => ({
  items: [{ id: "a", createdAt: "2026-08-09T10:00:00.000Z" }],
  next,
});

describe("cursors", () => {
  it("round-trip through the response and back into a request", () => {
    const body = toPageBody(slice({ createdAt: "2026-08-09T10:00:00.000Z", id: "a" }));
    expect(body.nextCursor).toBeTypeOf("string");

    const request = toPageRequest({ cursor: body.nextCursor ?? undefined });
    expect(request.after).toEqual({ createdAt: "2026-08-09T10:00:00.000Z", id: "a" });
  });

  it("are absent on the last page", () => {
    expect(toPageBody(slice(null)).nextCursor).toBeNull();
  });

  it("default the limit rather than fetching everything", () => {
    expect(toPageRequest({}).limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(toPageRequest({}).after).toBeNull();
  });

  /**
   * The cursor is interpolated into a timestamp comparison, so a value we did not mint
   * must not reach the query. Both of these are a 422 naming the field, not a 500.
   */
  it("reject anything this API did not issue", () => {
    expect(() => toPageRequest({ cursor: "not-base64-json" })).toThrow(ValidationFailed);
    expect(() =>
      toPageRequest({ cursor: Buffer.from(JSON.stringify(["not a date", "a"])).toString("base64url") }),
    ).toThrow(ValidationFailed);
  });

  it("reject a cursor of the wrong shape", () => {
    const cursor = Buffer.from(JSON.stringify({ createdAt: 1, id: 2 })).toString("base64url");
    expect(() => toPageRequest({ cursor })).toThrow(ValidationFailed);
  });
});
