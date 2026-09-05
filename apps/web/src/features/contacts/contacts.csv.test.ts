import { describe, expect, it } from "vitest";

import { MAX_IMPORT_ROWS, parseContactsCsv } from "./contacts.csv";

/**
 * Reading somebody else's list of people.
 *
 * The cases are what a real export hands you — a header or none, the number and the name in
 * either order, tabs where a comma was expected, a note with a comma inside quotes — rather
 * than a tidy grammar. A parser for this only earns its place if it survives what a
 * spreadsheet actually produces, and if the counts it reports match what the API will do:
 * a row with no number is skipped here exactly as it is there.
 */

describe("parsing a pasted contact list", () => {
  it("maps a header row to phone, name and notes", () => {
    const result = parseContactsCsv(
      ["phone,name,notes", "08031234567,Adaeze,VIP", "07011112222,Bola,"].join("\n"),
    );

    expect(result.headerSkipped).toBe(true);
    expect(result.rows).toEqual([
      { phone: "08031234567", displayName: "Adaeze", notes: "VIP" },
      { phone: "07011112222", displayName: "Bola" },
    ]);
    expect(result.skipped).toBe(0);
  });

  it("keeps a comma that lives inside a quoted field with the field", () => {
    const result = parseContactsCsv(
      ['phone,name,notes', '08031234567,Chidi,"called back, wants a quote"'].join("\n"),
    );

    expect(result.rows).toEqual([
      { phone: "08031234567", displayName: "Chidi", notes: "called back, wants a quote" },
    ]);
  });

  it("reads an escaped quote written as two quotes", () => {
    const result = parseContactsCsv(
      ['phone,name', '08031234567,"O""Brien"'].join("\n"),
    );

    expect(result.rows[0]).toEqual({ phone: "08031234567", displayName: 'O"Brien' });
  });

  it("takes a bare column of numbers as phones with no header", () => {
    const result = parseContactsCsv(["08031234567", "07011112222"].join("\n"));

    expect(result.headerSkipped).toBe(false);
    expect(result.rows).toEqual([{ phone: "08031234567" }, { phone: "07011112222" }]);
    expect(result.skipped).toBe(0);
  });

  it("skips every row of a name-only column, because none carries a number", () => {
    const result = parseContactsCsv(["Adaeze", "Bola", "Chidi"].join("\n"));

    expect(result.rows).toEqual([]);
    expect(result.skipped).toBe(3);
  });

  it("finds the phone when the header puts name before number", () => {
    const result = parseContactsCsv(["name,phone", "Adaeze,08031234567"].join("\n"));

    expect(result.rows).toEqual([{ phone: "08031234567", displayName: "Adaeze" }]);
  });

  it("finds the phone by shape when a name and number share a headerless row", () => {
    const result = parseContactsCsv(["Adaeze,08031234567", "08099998888,Bola"].join("\n"));

    expect(result.rows).toEqual([
      { phone: "08031234567", displayName: "Adaeze" },
      { phone: "08099998888", displayName: "Bola" },
    ]);
  });

  it("reads a tab-separated paste", () => {
    const result = parseContactsCsv(["phone\tname", "08031234567\tAdaeze"].join("\n"));

    expect(result.delimiter).toBe("\t");
    expect(result.rows).toEqual([{ phone: "08031234567", displayName: "Adaeze" }]);
  });

  it("reads a semicolon-separated paste", () => {
    const result = parseContactsCsv(["phone;name", "08031234567;Adaeze"].join("\n"));

    expect(result.delimiter).toBe(";");
    expect(result.rows).toEqual([{ phone: "08031234567", displayName: "Adaeze" }]);
  });

  it("handles CRLF line endings", () => {
    const result = parseContactsCsv("phone,name\r\n08031234567,Adaeze\r\n");

    expect(result.rows).toEqual([{ phone: "08031234567", displayName: "Adaeze" }]);
  });

  it("ignores blank lines between rows", () => {
    const result = parseContactsCsv(
      ["phone,name", "", "08031234567,Adaeze", "   ", "07011112222,Bola"].join("\n"),
    );

    expect(result.rows).toHaveLength(2);
    expect(result.skipped).toBe(0);
  });

  it("recognises a punctuated international number in a headerless row", () => {
    const result = parseContactsCsv("+234 (803) 123-4567,Adaeze");

    expect(result.rows).toEqual([{ phone: "+234 (803) 123-4567", displayName: "Adaeze" }]);
  });

  it("returns nothing for an empty paste", () => {
    const result = parseContactsCsv("   \n  \n");

    expect(result.rows).toEqual([]);
    expect(result.skipped).toBe(0);
    expect(result.headerSkipped).toBe(false);
  });

  it("keeps a duplicate number rather than folding it — the API does that", () => {
    const result = parseContactsCsv(["08031234567", "08031234567"].join("\n"));

    expect(result.rows).toHaveLength(2);
  });

  it("counts a bad row and keeps the good ones from the same paste", () => {
    const result = parseContactsCsv(
      ["phone,name", "08031234567,Adaeze", ",MissingNumber", "07011112222,Bola"].join("\n"),
    );

    expect(result.rows).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });

  it("caps at the batch limit and reports the surplus as dropped", () => {
    const many = Array.from({ length: MAX_IMPORT_ROWS + 25 }, (_, i) => `0803000${i}`);
    const result = parseContactsCsv(many.join("\n"));

    expect(result.rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(result.truncated).toBe(true);
    expect(result.dropped).toBe(25);
  });

  it("omits an empty note rather than sending a blank string", () => {
    const result = parseContactsCsv(["phone,name,notes", "08031234567,Adaeze,"].join("\n"));

    expect(result.rows[0]).not.toHaveProperty("notes");
  });
});
