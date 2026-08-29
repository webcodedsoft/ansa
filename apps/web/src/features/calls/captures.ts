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

export interface FormField {
  readonly key: string;
  readonly type: string;
}

export interface AgentColumn {
  readonly key: string;
  readonly type: string;
  /** Values collected for it in this range. Zero is the interesting case. */
  readonly count: number;
  /** In the data but not in the agent's form any more. Its history is still real. */
  readonly retired: boolean;
}

/**
 * The columns of one agent's dataset, taken from its form rather than from its answers.
 *
 * This is the whole point of reading the data per agent. Deriving columns from the values
 * that came back cannot show a question nobody ever answered — no value, no column — and a
 * question that never gets answered is the most broken question there is. The form knows it
 * was asked; the values only know it was not answered.
 *
 * Order is the operator's own, because that is the order the caller is asked in, and a table
 * whose columns run in the order of the conversation is readable in a way a frequency ranking
 * is not. Anything present in the range but missing from the form is appended and marked
 * retired: somebody removed the question and last month's answers are still real.
 */
export const columnsForAgent = (
  rows: readonly CapturedRow[],
  form: readonly FormField[],
): readonly AgentColumn[] => {
  const counts = new Map<string, number>();
  const typeOf = new Map<string, string>();
  for (const row of rows) {
    counts.set(row.fieldKey, (counts.get(row.fieldKey) ?? 0) + 1);
    typeOf.set(row.fieldKey, row.fieldType);
  }

  const configured = form.map((field) => ({
    key: field.key,
    type: field.type,
    count: counts.get(field.key) ?? 0,
    retired: false,
  }));

  const known = new Set(form.map((field) => field.key));
  const retired = [...counts.entries()]
    .filter(([key]) => !known.has(key))
    .map(([key, count]) => ({ key, type: typeOf.get(key) ?? "text", count, retired: true }));

  return [...configured, ...retired];
};

export interface AgentFieldHealth extends AgentColumn {
  readonly retried: number;
  readonly worstAttempts: number;
}

/** The same columns, with how hard each one was to collect. */
export const healthForAgent = (
  rows: readonly CapturedRow[],
  form: readonly FormField[],
): readonly AgentFieldHealth[] => {
  const seen = new Map<string, { retried: number; worst: number }>();
  for (const row of rows) {
    const at = seen.get(row.fieldKey) ?? { retried: 0, worst: 1 };
    if (row.attempts > 1) at.retried += 1;
    at.worst = Math.max(at.worst, row.attempts);
    seen.set(row.fieldKey, at);
  }
  return columnsForAgent(rows, form).map((column) => ({
    ...column,
    retried: seen.get(column.key)?.retried ?? 0,
    worstAttempts: seen.get(column.key)?.worst ?? 0,
  }));
};
