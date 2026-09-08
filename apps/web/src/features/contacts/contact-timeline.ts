import type { ContactDetail } from "./contacts.service";

type Calls = ContactDetail["calls"]["items"];
type Values = ContactDetail["contact"]["values"];
type Appointments = ContactDetail["appointments"];
type ConsentEvents = ContactDetail["consentEvents"];

/**
 * One entry on a person's timeline: something that happened, at a moment.
 *
 * A call and a confirmed value are different kinds of event and the page draws them
 * differently, so the union is discriminated rather than flattened behind a string.
 */
export type TimelineEntry =
  | { readonly kind: "call"; readonly at: string; readonly call: Calls[number] }
  | { readonly kind: "value"; readonly at: string; readonly value: Values[number] }
  | { readonly kind: "appointment"; readonly at: string; readonly appointment: Appointments[number] }
  | { readonly kind: "consent"; readonly at: string; readonly consent: ConsentEvents[number] };

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
  appointments: Appointments,
  consentEvents: ConsentEvents,
  /** Which end of the history this page is at. Both are true when it all fits on one page. */
  page: { readonly first: boolean; readonly last: boolean },
): readonly TimelineEntry[] => {
  const entries: TimelineEntry[] = calls.map((call) => ({ kind: "call", at: call.calledAt, call }));

  const oldest = calls.length === 0 ? null : (calls[calls.length - 1]?.calledAt ?? null);
  const newest = calls.length === 0 ? null : (calls[0]?.calledAt ?? null);

  /* The window rule is the same for everything that is not a call, so it is written once.
     It was inlined when values were the only other kind; a second and third copy of it is
     how one of them ends up on a page it does not belong to.
   *
   * It reaches past the newest call on the first page and past the oldest on the last, which
   * is the fix for something that had been quietly wrong: the old rule only reached forward,
   * so anything predating a person's first call — the import that created them, the consent
   * recorded before anybody rang — was held for "an older page" that does not exist. On a
   * history that fits one page it was invisible everywhere. */
  const inWindow = (at: string): boolean =>
    oldest === null || newest === null
      ? page.first
      : (at >= oldest || page.last) && (at <= newest || page.first);

  for (const value of values) {
    if (inWindow(value.updatedAt)) entries.push({ kind: "value", at: value.updatedAt, value });
  }

  /* At `bookedAt`, not `startsAt`. The spine is what has happened, and a viewing on Thursday
     has not happened — putting it in the future would push every past call below a thing that
     has not occurred yet. */
  for (const appointment of appointments) {
    if (inWindow(appointment.bookedAt)) {
      entries.push({ kind: "appointment", at: appointment.bookedAt, appointment });
    }
  }

  for (const consent of consentEvents) {
    if (inWindow(consent.at)) entries.push({ kind: "consent", at: consent.at, consent });
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
