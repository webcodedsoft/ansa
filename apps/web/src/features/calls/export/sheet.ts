import { label, type Pivoted } from "../captures";

/**
 * One tabular model, four file formats.
 *
 * CSV, Excel, PDF and JSON all render the same thing, and the one property worth
 * protecting is that they agree: an operator who exports the same view twice in two
 * formats must not get two different datasets. So the pivot happens once, here, and each
 * writer is a dumb rendering of the result. A format that reached back into the rows for
 * itself is how the column orders drift apart.
 */
export interface Sheet {
  readonly title: string;
  readonly columns: readonly string[];
  /** Already stringified. Formatting decisions belong here, not in four writers. */
  readonly rows: readonly (readonly string[])[];
}

/** Missing means the agent never asked, which is not the same as an empty answer. */
export const NOT_COLLECTED = "";

export const sheetOf = (pivoted: Pivoted, title = "Collected data"): Sheet => ({
  title,
  columns: ["When", "Caller", "Call", ...pivoted.columns.map((column) => label(column.key))],
  rows: pivoted.calls.map((call) => [
    call.calledAt,
    call.caller ?? "",
    call.carrierCallId,
    ...pivoted.columns.map((column) => call.values.get(column.key) ?? NOT_COLLECTED),
  ]),
});

/**
 * The dataset for something that will read it rather than look at it.
 *
 * Keyed by field key, not by the display label: a label is for a person and changes when
 * somebody rewords it, and anything parsing this wants the identifier the value is filed
 * under. That is the one place JSON deliberately disagrees with the other three formats.
 *
 * A field the call never collected is absent rather than null, so `in` distinguishes "not
 * asked" from "asked and empty" without a sentinel.
 */
export const toJson = (pivoted: Pivoted, exportedAt: Date): string =>
  `${JSON.stringify(
    {
      exportedAt: exportedAt.toISOString(),
      fields: pivoted.columns.map((column) => ({ key: column.key, calls: column.count })),
      calls: pivoted.calls.map((call) => ({
        callId: call.callId,
        carrierCallId: call.carrierCallId,
        caller: call.caller,
        calledAt: call.calledAt,
        values: Object.fromEntries(call.values),
      })),
    },
    null,
    2,
  )}\n`;
