import type { Sheet } from "./sheet";

/**
 * A PDF of the table, written by hand.
 *
 * The same trade as the spreadsheet writer: a PDF library is megabytes for what this needs,
 * and macOS can rasterise the result, so the test proves Quartz — a strict parser with no
 * interest in being kind — accepts the file.
 *
 * **Courier, and that is a decision.** A proportional font means the width of every string
 * has to be measured against a metrics table before a column can be sized or a value
 * truncated, and getting it slightly wrong means overlapping text. Courier is one of the
 * fourteen fonts every reader has, and every glyph is 600/1000 em wide — so truncation is
 * arithmetic rather than estimation, and digits line up in a column, which for a table of
 * phone and policy numbers is what you would have chosen anyway.
 *
 * **What this format loses.** The output is reduced to ASCII, and that is deliberate rather
 * than lazy. A PDF literal string under WinAnsiEncoding is one byte per character, so any
 * multi-byte UTF-8 written into one is read back as two wrong characters — "José" arrives as
 * "JosÃ©". Emitting Latin-1 bytes would widen the range slightly and still not reach Ọ, ẹ or
 * ṣ, so the honest line is ASCII: accents are decomposed away ("Nwosu-Ọkọ" prints as
 * "Nwosu-Oko"), the typographic punctuation a transcript picks up is mapped to its ASCII
 * twin, and anything left becomes "?" — which reads as "a character was here" rather than as
 * a space. The loss is confined to this format on purpose: CSV, Excel and JSON all carry the
 * caller's value exactly as it was heard. Doing better means embedding and subsetting a
 * Unicode font, which is a lot of machinery for a page somebody prints.
 */

const PAGE_WIDTH = 842; // A4 landscape, in points. A wide table wants the long edge.
const PAGE_HEIGHT = 595;
const MARGIN = 32;
const FONT_SIZE = 8;
const LINE_HEIGHT = 12;
/** Courier: every glyph is 600/1000 em. The whole reason this font was chosen. */
const CHAR_WIDTH = FONT_SIZE * 0.6;
const GUTTER = CHAR_WIDTH; // one character between columns

/**
 * Punctuation a transcript picks up that has no ASCII code point of its own.
 *
 * Mapped rather than dropped: an em dash becoming "?" in the middle of an address reads as
 * corruption, and becoming "-" reads as an address.
 */
const PUNCTUATION: ReadonlyMap<string, string> = new Map([
  ["\u2014", "-"],
  ["\u2013", "-"],
  ["\u2018", "'"],
  ["\u2019", "'"],
  ["\u201c", '"'],
  ["\u201d", '"'],
  ["\u2026", "..."],
  ["\u00a0", " "],
]);

/**
 * To something a one-byte PDF string can carry.
 *
 * NFD splits a letter from its accents and dropping the combining marks leaves the base
 * letter, so Ọ becomes O and é becomes e rather than either becoming nothing. What remains
 * outside ASCII becomes "?" — see the note at the top of this file for why the line is drawn
 * at ASCII rather than at Latin-1.
 */
const toAscii = (value: string): string => {
  const mapped = [...value].map((character) => PUNCTUATION.get(character) ?? character).join("");
  return mapped
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\x20-\x7e]/g, "?");
};

/** Backslash, and the parentheses that would otherwise end the string. */
const escapePdf = (value: string): string => value.replace(/([\\()])/g, "\\$1");

const text = (value: string, x: number, y: number, font: string): string =>
  `BT /${font} ${FONT_SIZE} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escapePdf(toAscii(value))}) Tj ET`;

/**
 * How wide each column is allowed to be, in characters.
 *
 * Sized to the longest value in the column, then scaled down together if the row does not
 * fit the page. Scaling all of them keeps the relative sizing somebody expects: the column
 * of one-word names stays narrow and the column of addresses stays wide.
 */
const columnWidths = (sheet: Sheet): readonly number[] => {
  const natural = sheet.columns.map((header, index) =>
    Math.max(header.length, ...sheet.rows.map((row) => (row[index] ?? "").length), 4),
  );
  const usable = PAGE_WIDTH - MARGIN * 2;
  const needed = natural.reduce((sum, chars) => sum + chars * CHAR_WIDTH + GUTTER, 0);
  if (needed <= usable) return natural;

  const scale = usable / needed;
  /* Never below four characters. Truncation costs three for the "..." itself, so a
     narrower column would be nothing but the marker — which tells a reader less than an
     honest admission that the table did not fit. */
  return natural.map((chars) => Math.max(4, Math.floor(chars * scale)));
};

const clip = (value: string, chars: number): string =>
  value.length <= chars ? value : `${value.slice(0, Math.max(1, chars - 3))}...`;

interface Page {
  readonly lines: readonly string[];
}

const paginate = (sheet: Sheet, generatedAt: Date): readonly Page[] => {
  const widths = columnWidths(sheet);
  const xs: number[] = [];
  let x = MARGIN;
  for (const chars of widths) {
    xs.push(x);
    x += chars * CHAR_WIDTH + GUTTER;
  }

  const top = PAGE_HEIGHT - MARGIN;
  const headerRows = 3; // title, generated-at, column headers
  const perPage = Math.max(1, Math.floor((top - MARGIN) / LINE_HEIGHT) - headerRows - 1);

  const pages: Page[] = [];
  const total = Math.max(1, Math.ceil(sheet.rows.length / perPage));

  for (let index = 0; index < total; index += 1) {
    const lines: string[] = [];
    let y = top - LINE_HEIGHT;

    lines.push(text(sheet.title, MARGIN, y, "F2"));
    y -= LINE_HEIGHT;
    lines.push(
      text(
        `Generated ${generatedAt.toISOString()} · ${sheet.rows.length} rows · page ${index + 1} of ${total}`,
        MARGIN,
        y,
        "F1",
      ),
    );
    y -= LINE_HEIGHT * 1.5;

    // Repeated on every page: a table whose headings are on page one only is a wall of
    // unlabelled columns from page two onward.
    sheet.columns.forEach((header, column) => {
      lines.push(text(clip(header, widths[column] ?? 4), xs[column] ?? MARGIN, y, "F2"));
    });
    y -= LINE_HEIGHT;

    for (const row of sheet.rows.slice(index * perPage, (index + 1) * perPage)) {
      row.forEach((value, column) => {
        if (value === "") return;
        lines.push(text(clip(value, widths[column] ?? 4), xs[column] ?? MARGIN, y, "F1"));
      });
      y -= LINE_HEIGHT;
    }

    pages.push({ lines });
  }

  return pages;
};

export const toPdf = (sheet: Sheet, generatedAt: Date): Uint8Array => {
  const pages = paginate(sheet, generatedAt);
  const encoder = new TextEncoder();

  /* Object numbering, fixed up front so the /Kids array can be written before the page
     objects exist: 1 catalog, 2 pages, 3 and 4 the fonts, then a page and a content stream
     for each page in turn. */
  const firstPage = 5;
  const pageIds = pages.map((_, index) => firstPage + index * 2);

  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>`,
  ];

  pages.forEach((page, index) => {
    const contentId = pageIds[index]! + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const stream = page.lines.join("\n");
    objects.push(`<< /Length ${encoder.encode(stream).length} >>\nstream\n${stream}\nendstream`);
  });

  /* Assembled byte by byte because the cross-reference table is a list of absolute file
     offsets. A reader that finds one wrong rejects the document, so the offsets are
     measured from the encoded bytes rather than from string lengths — the two differ the
     moment a caller's name is not ASCII. */
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(encoder.encode(body).length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefAt = encoder.encode(body).length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return encoder.encode(body + xref + trailer);
};
