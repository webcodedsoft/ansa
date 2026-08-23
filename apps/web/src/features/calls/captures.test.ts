import { describe, expect, it } from "vitest";

import { label, pivot, toCsv } from "./captures";
import type { CapturedRow } from "./calls.service";

/**
 * The two things that make this table readable: which columns exist, and what a value that
 * was never collected looks like.
 */

const row = (over: Partial<CapturedRow>): CapturedRow =>
  ({
    callId: "call-1",
    carrierCallId: "CA1",
    caller: "+2348138178550",
    agentId: "agent-1",
    calledAt: "2026-08-23T21:15:00.000Z",
    fieldKey: "callerName",
    fieldType: "name",
    value: "Sikiru",
    attempts: 1,
    confirmedAt: "2026-08-23T21:15:30.000Z",
    ...over,
  }) as CapturedRow;

describe("pivoting values into a table", () => {
  it("puts one call on one row", () => {
    const { calls } = pivot([
      row({ fieldKey: "callerName", value: "Sikiru" }),
      row({ fieldKey: "phone", value: "08138178550" }),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.values.get("callerName")).toBe("Sikiru");
    expect(calls[0]?.values.get("phone")).toBe("08138178550");
  });

  it("orders columns by how often the field was collected", () => {
    /* A form's required fields appear on nearly every call and its optional ones rarely,
       so frequency puts the spine of the form on the left where it is read first. */
    /* The frequent field is named so it sorts *last* alphabetically. The first version of
       this used "common" and "rare", where both orderings agree — so it passed against a
       sort that ignored frequency entirely. */
    const { columns } = pivot([
      row({ callId: "a", fieldKey: "alpha", value: "x" }),
      row({ callId: "a", fieldKey: "zebra", value: "y" }),
      row({ callId: "b", carrierCallId: "CA2", fieldKey: "zebra", value: "z" }),
    ]);

    expect(columns.map((c) => c.key)).toEqual(["zebra", "alpha"]);
  });

  it("orders equally common columns by name, so the table does not shuffle", () => {
    const { columns } = pivot([
      row({ callId: "a", fieldKey: "zebra", value: "x" }),
      row({ callId: "a", fieldKey: "alpha", value: "y" }),
    ]);

    expect(columns.map((c) => c.key)).toEqual(["alpha", "zebra"]);
  });

  it("leaves a gap for a field this call never collected", () => {
    /* Not an empty string in the map: "we asked and they said nothing" and "this agent
       never asks this" have to look different, and the table renders the gap as a dash. */
    const { calls } = pivot([
      row({ callId: "a", fieldKey: "callerName", value: "Sikiru" }),
      row({ callId: "b", carrierCallId: "CA2", fieldKey: "phone", value: "0813" }),
    ]);

    const first = calls.find((c) => c.callId === "a");
    expect(first?.values.has("phone")).toBe(false);
  });
});

describe("the export", () => {
  it("quotes a value containing a comma so the columns survive", () => {
    const csv = toCsv(pivot([row({ fieldKey: "address", value: "12 Bode Thomas, Surulere" })]));
    expect(csv).toContain('"12 Bode Thomas, Surulere"');
    // One header line and one data line, and the comma did not make a third column.
    expect(csv.trim().split("\r\n")).toHaveLength(2);
  });

  it("doubles a quote inside a value rather than ending the field", () => {
    const csv = toCsv(pivot([row({ fieldKey: "note", value: 'they said "urgent"' })]));
    expect(csv).toContain('"they said ""urgent"""');
  });

  it("survives a newline inside a value", () => {
    const csv = toCsv(pivot([row({ fieldKey: "note", value: "line one\nline two" })]));
    expect(csv).toContain('"line one\nline two"');
  });

  it("writes an empty cell where the call has no value for a column", () => {
    const csv = toCsv(
      pivot([
        row({ callId: "a", fieldKey: "callerName", value: "Sikiru" }),
        row({ callId: "b", carrierCallId: "CA2", fieldKey: "phone", value: "0813" }),
      ]),
    );
    const lines = csv.trim().split("\r\n");
    // Every row has the same number of columns, which is the whole contract of a CSV.
    const widths = new Set(lines.map((line) => line.split('","').length));
    expect(widths.size).toBe(1);
  });

  it("starts with a BOM so Excel reads Nigerian names correctly", () => {
    /* Without it Excel on Windows decodes UTF-8 as Latin-1 and "Adaeze Nwosu-Ọkọ" arrives
       as mojibake — correct file, unreadable to the people most likely to open it. */
    const csv = toCsv(pivot([row({ value: "Adaeze Nwosu-Ọkọ" })]));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("Adaeze Nwosu-Ọkọ");
  });
});

describe("naming a field for a person", () => {
  it("splits the styles operators actually write", () => {
    expect(label("callerName")).toBe("Caller name");
    expect(label("policy_number")).toBe("Policy number");
    expect(label("date-of-birth")).toBe("Date of birth");
  });

  it("returns a key it cannot improve unharmed", () => {
    expect(label("dob")).toBe("Dob");
  });
});
