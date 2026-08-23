import type { Sheet } from "./sheet";

/**
 * RFC 4180. Quoted always, rather than only when a value contains a comma.
 *
 * Callers give values with commas, quotes and newlines in them — an address, a spelled-out
 * name, anything the transcriber ran together. Deciding per value which need quoting is the
 * kind of rule that is right until the first address, and the cost of always quoting is a
 * slightly larger file that every spreadsheet reads identically.
 */
const cell = (value: string): string => `"${value.replace(/"/g, '""')}"`;

/**
 * The dataset as a spreadsheet anything can open.
 *
 * A leading BOM because Excel on Windows reads a plain UTF-8 CSV as Latin-1 and turns every
 * Nigerian name with an accent into mojibake — the file is correct without it and unreadable
 * to the people most likely to open it. For Excel specifically the xlsx writer is better
 * still: it keeps the leading zero on a phone number, which no CSV can promise.
 */
export const toCsv = (sheet: Sheet): string => {
  const lines = [sheet.columns.map(cell).join(",")];
  for (const row of sheet.rows) lines.push(row.map(cell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
};
