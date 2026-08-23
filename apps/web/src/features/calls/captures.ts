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

/**
 * RFC 4180. Quoted always, rather than only when a value contains a comma.
 *
 * Callers give values with commas, quotes and newlines in them — an address, a spelled-out
 * name, anything the transcriber ran together. Deciding per value which need quoting is
 * the kind of rule that is right until the first address, and the cost of always quoting
 * is a slightly larger file that every spreadsheet reads identically.
 */
const cell = (value: string): string => `"${value.replace(/"/g, '""')}"`;

/**
 * The dataset as a spreadsheet.
 *
 * Same rows and the same column order the table shows, so what somebody exports is what
 * they were looking at. A leading BOM because Excel on Windows reads a plain UTF-8 CSV as
 * Latin-1 and turns every Nigerian name with an accent into mojibake — the file is correct
 * without it and unreadable to the people most likely to open it.
 */
export const toCsv = (pivoted: Pivoted): string => {
  const header = ["When", "Caller", "Call", ...pivoted.columns.map((c) => label(c.key))];
  const lines = [header.map(cell).join(",")];
  for (const call of pivoted.calls) {
    lines.push(
      [
        call.calledAt,
        call.caller ?? "",
        call.carrierCallId,
        ...pivoted.columns.map((column) => call.values.get(column.key) ?? ""),
      ]
        .map(cell)
        .join(","),
    );
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
};
