import type { ContactDetail } from "./contacts.service";

type Calls = ContactDetail["calls"]["items"];
type Values = ContactDetail["contact"]["values"];

/**
 * One entry on a person's timeline: something that happened, at a moment.
 *
 * A call and a confirmed value are different kinds of event and the page draws them
 * differently, so the union is discriminated rather than flattened behind a string.
 */
export type TimelineEntry =
  | { readonly kind: "call"; readonly at: string; readonly call: Calls[number] }
  | { readonly kind: "value"; readonly at: string; readonly value: Values[number] };

/**
 * Calls and confirmed values on one time-ordered spine, newest first.
 *
 * The window is the point. The call list is paged, so a page covers a span of time rather
 * than a whole history — and a value confirmed last week does not belong on a page showing
 * calls from March. Values are interleaved only when they fall inside the span this page
 * covers, which on the first page reaches forward to now: anything confirmed since the newest
 * call still happened after it.
 *
 * A person with no calls still has a spine on the first page, because a contact can be
 * imported and hold values before anybody rings them.
 */
export const timelineOf = (
  calls: Calls,
  values: Values,
  firstPage: boolean,
): readonly TimelineEntry[] => {
  const entries: TimelineEntry[] = calls.map((call) => ({ kind: "call", at: call.calledAt, call }));

  const oldest = calls.length === 0 ? null : (calls[calls.length - 1]?.calledAt ?? null);
  const newest = calls.length === 0 ? null : (calls[0]?.calledAt ?? null);

  for (const value of values) {
    const inWindow =
      oldest === null || newest === null
        ? firstPage
        : value.updatedAt >= oldest && (firstPage || value.updatedAt <= newest);
    if (inWindow) entries.push({ kind: "value", at: value.updatedAt, value });
  }

  /* ISO-8601 in one zone sorts lexically, which is what the API sends and what every other
     list in the console already relies on. */
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
};

/**
 * How many of these calls landed in the last seven days, or null when it cannot be known.
 *
 * Null rather than a guess: the count is only truthful when this page holds every call the
 * person has made, and a paged history could hide a dozen more inside the week. A figure that
 * is right for most people and quietly wrong for the busiest ones is worse than no figure.
 */
export const callsThisWeek = (calls: Calls, total: number, now: Date): number | null => {
  if (calls.length < total) return null;
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  return calls.filter((call) => call.calledAt >= since).length;
};

/** Whole days between an instant and now, floored. Null in, null out. */
export const daysSince = (iso: string | null, now: Date): number | null => {
  if (iso === null) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
};
