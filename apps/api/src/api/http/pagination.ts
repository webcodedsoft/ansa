import type { PageCursor, PageRequest, PageSlice } from "@ansa/db";

import { ValidationFailed } from "./problem";
import { integer, list, nullable, object, optional, text, type Infer, type Schema } from "./schema";

/**
 * The one pagination contract every list endpoint uses.
 *
 * `?limit=&cursor=` in, `{ items, nextCursor }` out, and the cursor is opaque. Opaque
 * matters: it is a base64 of the keyset the query actually uses, and the day a list needs
 * a different sort key, every existing client keeps working because none of them ever
 * parsed it.
 */

export const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;

export const pageQuery = object({
  limit: optional(integer({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
  cursor: optional(text({ maxLength: 512 })),
});

export type PageQuery = Infer<typeof pageQuery>;

const encodeCursor = (cursor: PageCursor): string =>
  Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), "utf8").toString("base64url");

const decodeCursor = (raw: string): PageCursor => {
  // A cursor is something we minted, so anything unreadable is either a typo or somebody
  // poking at it. Both get the same answer, and neither reaches the query — an unchecked
  // value here would be interpolated into a timestamp comparison.
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error("shape");
    const [createdAt, id] = parsed as unknown[];
    if (typeof createdAt !== "string" || typeof id !== "string") throw new Error("shape");
    if (Number.isNaN(Date.parse(createdAt))) throw new Error("timestamp");
    return { createdAt, id };
  } catch {
    throw new ValidationFailed([{ path: "cursor", message: "is not a cursor this API issued" }]);
  }
};

export const toPageRequest = (query: PageQuery): PageRequest => ({
  limit: query.limit ?? DEFAULT_PAGE_LIMIT,
  after: query.cursor === undefined ? null : decodeCursor(query.cursor),
});

/** The response schema for a list of `item`. Declared per endpoint so the item type shows up in the spec. */
export const pageResponse = <T>(item: Schema<T>) =>
  object({ items: list(item), nextCursor: nullable(text()) });

export const toPageBody = <T>(
  slice: PageSlice<T>,
): { items: readonly T[]; nextCursor: string | null } => ({
  items: slice.items,
  nextCursor: slice.next === null ? null : encodeCursor(slice.next),
});
