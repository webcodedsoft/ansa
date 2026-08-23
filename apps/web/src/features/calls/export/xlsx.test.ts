import { describe, expect, it } from "vitest";

import type { Sheet } from "./sheet";
import { toXlsx } from "./xlsx";

/**
 * An xlsx is a ZIP of XML, so these read the archive back rather than asserting on bytes.
 *
 * A corrupt spreadsheet is invisible until somebody opens it in Excel and is told the file
 * cannot be repaired, which is the worst possible moment to find out. The reader below walks
 * the central directory, which is the only correct way into a ZIP — if it can extract a
 * part, so can Excel.
 */

const u16 = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) |
    ((bytes[at + 1] ?? 0) << 8) |
    ((bytes[at + 2] ?? 0) << 16) |
    ((bytes[at + 3] ?? 0) << 24)) >>>
  0;

/**
 * The same checksum Excel computes before it will open a part.
 *
 * The reader below used to skip this, and a mutation zeroing every CRC produced a file it
 * happily extracted — while Excel would have called it corrupt and offered to repair it.
 * Checking here is the difference between "the bytes are arranged like a ZIP" and "a reader
 * will accept it".
 */
const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
};

const read = (archive: Uint8Array): Map<string, string> => {
  const decoder = new TextDecoder();
  let eocd = archive.length - 22;
  while (eocd >= 0 && u32(archive, eocd) !== 0x06054b50) eocd -= 1;
  expect(eocd, "no end-of-central-directory record").toBeGreaterThanOrEqual(0);

  const count = u16(archive, eocd + 10);
  let at = u32(archive, eocd + 16);
  const parts = new Map<string, string>();

  for (let i = 0; i < count; i += 1) {
    expect(u32(archive, at), "central directory entry signature").toBe(0x02014b50);
    const size = u32(archive, at + 20);
    const nameLength = u16(archive, at + 28);
    const extraLength = u16(archive, at + 30);
    const commentLength = u16(archive, at + 32);
    const localAt = u32(archive, at + 42);
    const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength));

    expect(u32(archive, localAt), `local header for ${name}`).toBe(0x04034b50);
    const localNameLength = u16(archive, localAt + 26);
    const localExtraLength = u16(archive, localAt + 28);
    const dataAt = localAt + 30 + localNameLength + localExtraLength;
    const data = archive.subarray(dataAt, dataAt + size);
    expect(crc32(data), `checksum for ${name}`).toBe(u32(archive, at + 16));
    parts.set(name, decoder.decode(data));

    at += 46 + nameLength + extraLength + commentLength;
  }
  return parts;
};

const sheetOf = (rows: readonly (readonly string[])[]): Sheet => ({
  title: "Collected data",
  columns: ["Caller name", "Phone"],
  rows,
});

describe("the spreadsheet", () => {
  it("is an archive holding every part the format requires", () => {
    const parts = read(toXlsx(sheetOf([["Sikiru", "08138178550"]])));
    expect([...parts.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
    ]);
  });

  it("keeps a leading zero on a phone number", () => {
    /* The reason this writer exists rather than a renamed CSV. Excel reads an untyped
       08138178550 as 8138178550, and a long policy number as scientific notation, so every
       cell is written as an inline string. */
    const sheet = read(toXlsx(sheetOf([["Sikiru", "08138178550"]]))).get("xl/worksheets/sheet1.xml");
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain('<t xml:space="preserve">08138178550</t>');
  });

  it("escapes a value that would otherwise break the XML", () => {
    const sheet = read(toXlsx(sheetOf([['Ada & "Sons" <Ltd>', "0805"]]))).get(
      "xl/worksheets/sheet1.xml",
    );
    expect(sheet).toContain('Ada &amp; "Sons" &lt;Ltd&gt;');
  });

  it("drops a control character rather than losing the whole workbook", () => {
    /* XML 1.0 cannot carry most control characters at all and Excel rejects the entire file
       when it meets one, so a single stray byte in one transcript would otherwise cost the
       operator every row in the export. */
    const dirty = `Sik${String.fromCharCode(1)}iru`;
    const sheet = read(toXlsx(sheetOf([[dirty, "0805"]]))).get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain("Sikiru");
    expect(sheet).not.toContain(String.fromCharCode(1));
  });

  it("carries a name the base fonts could not print", () => {
    // A data format keeps the value exactly. Only the PDF is allowed to degrade it.
    const sheet = read(toXlsx(sheetOf([["Adaeze Nwosu-Ọkọ", "0805"]]))).get(
      "xl/worksheets/sheet1.xml",
    );
    expect(sheet).toContain("Adaeze Nwosu-Ọkọ");
  });

  it("numbers cells across into a second letter past column Z", () => {
    const wide = Array.from({ length: 28 }, (_, i) => `c${i}`);
    const sheet = read(toXlsx({ title: "t", columns: wide, rows: [wide] })).get(
      "xl/worksheets/sheet1.xml",
    );
    expect(sheet).toContain('r="Z1"');
    expect(sheet).toContain('r="AA1"');
    expect(sheet).toContain('r="AB1"');
  });

  it("refuses a sheet name Excel would refuse", () => {
    const parts = read(
      toXlsx({
        title: "Data: 2026/08 [final] and a very long title indeed",
        columns: ["a"],
        rows: [],
      }),
    );
    const name = /name="([^"]*)"/.exec(parts.get("xl/workbook.xml") ?? "")?.[1] ?? "";
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[[\]:*?/\\]/);
  });

  it("writes the same bytes for the same rows", () => {
    // A "now" timestamp inside the archive would make this untestable and every diff noise.
    expect(Array.from(toXlsx(sheetOf([["Sikiru", "0813"]])))).toEqual(
      Array.from(toXlsx(sheetOf([["Sikiru", "0813"]]))),
    );
  });
});
