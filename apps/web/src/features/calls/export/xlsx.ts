import type { Sheet } from "./sheet";

/**
 * A real .xlsx, written by hand.
 *
 * The alternative was a dependency. `exceljs` and SheetJS are both several megabytes for
 * what this needs — one sheet, one header row, text cells — and this console's dependency
 * list is deliberately short. What made it worth owning is that it is fully verifiable: an
 * xlsx is a ZIP of XML, Python's `zipfile` is in its standard library, and the test opens
 * the file and reads the cells back rather than asserting on bytes.
 *
 * Renaming a CSV to .xls was the other option and is not one. Excel warns that the format
 * does not match the extension, the separator is at the mercy of the reader's locale, and
 * every value arrives as whatever Excel guesses — which turns a Nigerian phone number into
 * 8.13818e+10 and a policy number into a date.
 *
 * Entries are STORED rather than deflated. Compressing would mean shipping a deflate
 * implementation or reaching for zlib bindings; a few thousand rows of text is small
 * either way, and method 0 has been in the ZIP format from the beginning.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/**
 * XML text, escaped.
 *
 * Control characters are removed rather than escaped. XML 1.0 cannot represent most of
 * them at any cost, and Excel rejects the entire workbook when it meets one — so a single
 * stray byte in one transcript would cost the operator the whole export.
 */
const xml = (value: string): string =>
  value
    // eslint-disable-next-line no-control-regex -- removing exactly these is the point.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** A1, B1 … Z1, AA1. Excel wants the reference on every cell. */
const ref = (column: number, row: number): string => {
  let name = "";
  let n = column;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return `${name}${row}`;
};

/**
 * Every cell is an inline string, deliberately.
 *
 * A phone number is not a number. `08138178550` typed as one loses its leading zero, and a
 * long policy number becomes scientific notation. Excel's own guess is the bug this exists
 * to avoid, and it is the reason exporting a CSV and hoping was never sufficient.
 */
const cell = (value: string, column: number, row: number): string =>
  `<c r="${ref(column, row)}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;

const sheetXml = (sheet: Sheet): string => {
  const rows = [
    `<row r="1">${sheet.columns.map((header, i) => cell(header, i, 1)).join("")}</row>`,
    ...sheet.rows.map(
      (row, index) =>
        `<row r="${index + 2}">${row.map((value, i) => cell(value, i, index + 2)).join("")}</row>`,
    ),
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
};

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

/** Excel refuses a sheet name over 31 characters or holding any of `[]:*?/\\`. */
const sheetName = (title: string): string => {
  const cleaned = title.replace(/[[\]:*?/\\]/g, " ").trim();
  return (cleaned === "" ? "Sheet1" : cleaned).slice(0, 31);
};

const workbookXml = (sheet: Sheet): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName(sheet.title))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

interface Entry {
  readonly name: string;
  readonly data: Uint8Array;
}

const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
];

/**
 * A ZIP of stored entries.
 *
 * The timestamp is fixed rather than `now`, so two exports of the same rows are
 * byte-identical. That is what makes this testable, and an archive whose bytes change
 * every second is a nuisance to diff for a benefit nobody asked for.
 */
const zip = (entries: readonly Entry[]): Uint8Array => {
  const encoder = new TextEncoder();
  const parts: number[] = [];
  const central: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const sum = crc32(entry.data);
    const local = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      // 1 January 1980, which is where the format's own clock starts.
      ...u16(0),
      ...u16(0x21),
      ...u32(sum),
      ...u32(entry.data.length),
      ...u32(entry.data.length),
      ...u16(name.length),
      ...u16(0),
    ];
    parts.push(...local, ...name, ...entry.data);
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0x21),
      ...u32(sum),
      ...u32(entry.data.length),
      ...u32(entry.data.length),
      ...u16(name.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...name,
    );
    offset += local.length + name.length + entry.data.length;
  }

  const centralStart = offset;
  parts.push(...central);
  parts.push(
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(centralStart),
    ...u16(0),
  );
  return Uint8Array.from(parts);
};

export const toXlsx = (sheet: Sheet): Uint8Array => {
  const encoder = new TextEncoder();
  return zip([
    { name: "[Content_Types].xml", data: encoder.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: encoder.encode(ROOT_RELS) },
    { name: "xl/workbook.xml", data: encoder.encode(workbookXml(sheet)) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(WORKBOOK_RELS) },
    { name: "xl/worksheets/sheet1.xml", data: encoder.encode(sheetXml(sheet)) },
  ]);
};
