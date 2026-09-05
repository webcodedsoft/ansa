/**
 * Reading a pasted or uploaded list of people into rows the import endpoint understands.
 *
 * A person bringing a list has it in whatever a spreadsheet exported — headers or none, commas
 * or tabs, a number column beside a name or a bare column of numbers. Retyping it is where the
 * mistakes come from, so this is deliberately forgiving: it guesses the delimiter, notices a
 * header when there is one, and finds the phone column by shape when there is not.
 *
 * **It parses, it does not decide.** What comes back is shown in a preview before anything is
 * sent, which is what makes leniency safe — the worst a wrong guess does is put a value in a
 * visible box. Nothing here throws: a row it cannot read a number from is counted in `skipped`
 * rather than failing the batch, exactly as the API itself skips a bad phone rather than
 * refusing the upload.
 *
 * The phone is normalised by the API, not here — a Nigerian national number becomes `+234…`
 * there. This only has to hand it the digits; it must not reformat them and risk changing a
 * number the person actually typed.
 */

export interface ParsedContact {
  readonly phone: string;
  readonly displayName?: string;
  readonly notes?: string;
}

export interface CsvParseResult {
  /** Rows carrying a readable phone, capped at `MAX_IMPORT_ROWS`. These are what gets sent. */
  readonly rows: readonly ParsedContact[];
  /** Data rows that held no readable phone, so no contact could be made from them. */
  readonly skipped: number;
  /** True when there were more usable rows than the cap allows and the surplus was dropped. */
  readonly truncated: boolean;
  /** How many usable rows the cap dropped. Zero unless `truncated`. */
  readonly dropped: number;
  /** True when the first record was read as column headings rather than as a person. */
  readonly headerSkipped: boolean;
  /** The delimiter chosen for this input: a comma, a tab, or a semicolon. */
  readonly delimiter: string;
}

/**
 * The API caps a batch at 5000 rows and skips the rest. Capping here too means the preview
 * and the result agree — the person is told their paste was truncated before they send it,
 * rather than wondering later why the counts do not add up.
 */
export const MAX_IMPORT_ROWS = 5000;

const CANDIDATE_DELIMITERS = [",", "\t", ";"] as const;

/** A cell reads as a phone if it is punctuation-and-digits with enough digits to be a number. */
const looksLikePhone = (cell: string): boolean => {
  const trimmed = cell.trim();
  if (trimmed === "") return false;
  if (!/^[+()\d\s.-]+$/.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, "").length;
  return digits >= 5;
};

/** Header words, matched loosely because every spreadsheet names these columns differently. */
const isPhoneHeader = (h: string): boolean =>
  /phone|number|\bno\b|tel|msisdn|mobile|cell|whatsapp/.test(h);
const isNameHeader = (h: string): boolean => /name|contact|customer|caller|person/.test(h);
const isNotesHeader = (h: string): boolean => /note|comment|remark|memo|detail/.test(h);

/**
 * Split the text into records of fields, quote-aware.
 *
 * A quoted field may hold the delimiter, a newline, and an escaped quote written as two
 * quotes — the RFC 4180 shape every spreadsheet exports. Everything outside quotes is plain.
 */
const splitRecords = (text: string, delimiter: string): string[][] => {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;

  const endField = (): void => {
    record.push(field);
    field = "";
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delimiter) endField();
    else if (ch === "\n") endRecord();
    else if (ch === "\r") {
      /* Swallow a lone CR or the CR of a CRLF; the following LF, if any, ends the record. */
      if (text[i + 1] !== "\n") endRecord();
    } else field += ch;
  }
  /* A final field with no trailing newline still counts, but a trailing newline must not
     invent an empty record after it. */
  if (field !== "" || record.length > 0) endRecord();

  return records;
};

/** A record is empty when every cell is blank — a spacer line, not a person. */
const isBlankRecord = (record: readonly string[]): boolean =>
  record.every((cell) => cell.trim() === "");

/** How many fields the first line yields under a delimiter, so the best delimiter can win. */
const firstLineFieldCount = (text: string, delimiter: string): number => {
  const newline = text.indexOf("\n");
  const line = newline === -1 ? text : text.slice(0, newline);
  let count = 1;
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === delimiter && !inQuotes) count += 1;
  }
  return count;
};

/**
 * The delimiter that carves the first line into the most columns.
 *
 * Comma wins ties, because it is what "CSV" means and what most exports use; a tab or a
 * semicolon only takes over when it plainly splits the row where a comma does not.
 */
const chooseDelimiter = (text: string): string => {
  let best = ",";
  let bestCount = 0;
  for (const delimiter of CANDIDATE_DELIMITERS) {
    const count = firstLineFieldCount(text, delimiter);
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
};

/** Read a person out of one record, using the header map where there is one. */
const rowFrom = (
  record: readonly string[],
  columns: { phone: number; name: number; notes: number } | null,
): ParsedContact | null => {
  const at = (i: number): string => (i >= 0 ? (record[i] ?? "").trim() : "");
  const named = (phone: string, name: string, notes: string): ParsedContact => ({
    phone,
    ...(name === "" ? {} : { displayName: name }),
    ...(notes === "" ? {} : { notes }),
  });

  if (columns !== null && columns.phone >= 0) {
    /* A header told us which column is the phone, so trust it even if the value is messy —
       the API will normalise it or skip it, and second-guessing the person's own header is
       how a mapped column gets read as a name. */
    const phone = at(columns.phone);
    if (phone === "") return null;
    return named(phone, at(columns.name), at(columns.notes));
  }

  /* No header, or a header with no phone column: find the number by its shape, and read the
     first ordinary cell as the name and the next as a note. This is what makes a bare column
     of numbers, or a name-and-number pair in either order, both work. */
  const cells = record.map((cell) => cell.trim()).filter((cell) => cell !== "");
  const phoneAt = cells.findIndex(looksLikePhone);
  if (phoneAt === -1) return null;
  const rest = cells.filter((_, i) => i !== phoneAt);
  return named(cells[phoneAt] ?? "", rest[0] ?? "", rest[1] ?? "");
};

/** Build the column map from a header record, or null when it is not a header. */
const headerColumns = (
  record: readonly string[],
): { phone: number; name: number; notes: number } | null => {
  const headers = record.map((cell) => cell.trim().toLowerCase());
  if (!headers.some((h) => isPhoneHeader(h) || isNameHeader(h) || isNotesHeader(h))) return null;
  return {
    phone: headers.findIndex(isPhoneHeader),
    name: headers.findIndex((h) => isNameHeader(h) && !isPhoneHeader(h)),
    notes: headers.findIndex(isNotesHeader),
  };
};

export const parseContactsCsv = (text: string): CsvParseResult => {
  const delimiter = chooseDelimiter(text);
  const records = splitRecords(text, delimiter).filter((r) => !isBlankRecord(r));

  if (records.length === 0) {
    return {
      rows: [],
      skipped: 0,
      truncated: false,
      dropped: 0,
      headerSkipped: false,
      delimiter,
    };
  }

  const columns = headerColumns(records[0] ?? []);
  const headerSkipped = columns !== null;
  const dataRecords = headerSkipped ? records.slice(1) : records;

  const usable: ParsedContact[] = [];
  let skipped = 0;
  for (const record of dataRecords) {
    const row = rowFrom(record, columns);
    if (row === null) skipped += 1;
    else usable.push(row);
  }

  const truncated = usable.length > MAX_IMPORT_ROWS;
  const dropped = truncated ? usable.length - MAX_IMPORT_ROWS : 0;

  return {
    rows: truncated ? usable.slice(0, MAX_IMPORT_ROWS) : usable,
    skipped,
    truncated,
    dropped,
    headerSkipped,
    delimiter,
  };
};
