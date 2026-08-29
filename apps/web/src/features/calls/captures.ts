import type { CapturedRow } from "./calls.service";

/**
 * Turning one-row-per-value into one-row-per-call.
 *
 * The API returns a row per value because it has to: two agents have different forms, so
 * there is no column list that is right for both, and inventing one server-side would
 * silently drop whichever agent's fields were not in it. The column list is a property of
 * the rows that actually came back, so it is computed from them here.
 *
 * Columns are ordered by how often a field appears rather than alphabetically. A form's
 * required fields are collected on nearly every call and its optional ones rarely, so
 * frequency puts the spine of the form on the left where it is read first.
 */

export interface CaptureColumn {
  readonly key: string;
  readonly count: number;
}

export interface CaptureCall {
  readonly callId: string;
  readonly carrierCallId: string;
  readonly caller: string | null;
  readonly calledAt: string;
  /** Field key to value. Missing means the field was never collected on this call. */
  readonly values: ReadonlyMap<string, string>;
}

export interface Pivoted {
  readonly columns: readonly CaptureColumn[];
  readonly calls: readonly CaptureCall[];
}

export const pivot = (rows: readonly CapturedRow[]): Pivoted => {
  const counts = new Map<string, number>();
  /* Insertion order is call order, because the API returns newest call first and every
     row of one call arrives together. Relying on that beats sorting again by a date we
     would have to re-parse. */
  const byCall = new Map<string, { call: Omit<CaptureCall, "values">; values: Map<string, string> }>();

  for (const row of rows) {
    counts.set(row.fieldKey, (counts.get(row.fieldKey) ?? 0) + 1);
    const existing = byCall.get(row.callId);
    const target =
      existing ??
      {
        call: {
          callId: row.callId,
          carrierCallId: row.carrierCallId,
          caller: row.caller,
          calledAt: row.calledAt,
        },
        values: new Map<string, string>(),
      };
    target.values.set(row.fieldKey, row.value);
    if (existing === undefined) byCall.set(row.callId, target);
  }

  const columns = [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    // Ties broken by name, so the order does not shuffle between two loads of the same data.
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));

  return {
    columns,
    calls: [...byCall.values()].map((entry) => ({ ...entry.call, values: entry.values })),
  };
};

/**
 * A field key as a person would say it.
 *
 * Operators write keys in whatever style suits them — `callerName`, `policy_number`, `dob`
 * — and asking them to maintain a display label as well would be a second thing to keep in
 * step with the first. Splitting camel case and separators covers every style anyone has
 * used, and a key it cannot improve is returned unharmed.
 */
export const label = (key: string): string => {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (spaced === "") return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
};

export interface FieldSummary {
  readonly key: string;
  /** Values collected for this field across the range. */
  readonly count: number;
  /** How many of them the agent had to ask for more than once. */
  readonly retried: number;
  /** The worst single case, which is what somebody rewriting a prompt wants to see. */
  readonly worstAttempts: number;
}

/**
 * How each field is behaving, not just how often it appears.
 *
 * `attempts` has been stored since the table existed and shown nowhere. The migration that
 * added it says why it is kept: a field that regularly takes three goes is a field whose
 * prompt needs rewriting, and that is invisible unless somebody counts. This is the count.
 *
 * Derived from the rows on screen rather than from a separate aggregate query. Those rows
 * are the whole filtered range unless the API says it truncated them, and the page says so
 * loudly when it does — so a second round trip would buy a number that is already right.
 */
export const summarise = (rows: readonly CapturedRow[]): readonly FieldSummary[] => {
  const byField = new Map<string, { count: number; retried: number; worst: number }>();
  for (const row of rows) {
    const seen = byField.get(row.fieldKey) ?? { count: 0, retried: 0, worst: 1 };
    seen.count += 1;
    if (row.attempts > 1) seen.retried += 1;
    seen.worst = Math.max(seen.worst, row.attempts);
    byField.set(row.fieldKey, seen);
  }
  return [...byField.entries()]
    .map(([key, seen]) => ({
      key,
      count: seen.count,
      retried: seen.retried,
      worstAttempts: seen.worst,
    }))
    // Most-retried first: the point of the panel is what needs attention, not an index.
    .sort((a, b) => b.retried - a.retried || b.count - a.count);
};
