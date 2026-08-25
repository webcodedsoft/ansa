import { inflateSync } from "node:zlib";

/**
 * The words out of a PDF, or an honest refusal.
 *
 * A PDF does not store text. It stores instructions for painting glyphs, and the mapping from
 * a byte in a content stream back to a character is whatever the font's encoding says it is.
 * For a document produced by Word, Google Docs or a printer driver that encoding is usually a
 * standard one and the bytes are the characters, which is the case this reads. For a document
 * using a subset font with a custom encoding, the same bytes mean something else entirely.
 *
 * That second case is why `readable` exists. Extracting text from such a file yields
 * plausible-looking rubbish — the right length, the right shape, and wrong — and storing it
 * would have an agent read nonsense down a phone line to a customer. So the result is scored,
 * and a low score returns a refusal the operator can act on rather than a mess they have to
 * notice for themselves. Failing loudly is worth more here than succeeding on one more file.
 */

/** How much of the output must be ordinary text before the result is trusted. */
const LEGIBLE_RATIO = 0.85;
const MIN_LENGTH = 24;

const isOrdinary = (code: number): boolean =>
  code === 9 ||
  code === 10 ||
  code === 13 ||
  (code >= 32 && code <= 126) ||
  // Latin-1 and Latin Extended-A, which covers a naira price list and a Yoruba name.
  (code >= 0xa0 && code <= 0x17f) ||
  code === 0x2018 ||
  code === 0x2019 ||
  code === 0x201c ||
  code === 0x201d ||
  code === 0x2013 ||
  code === 0x2014 ||
  code === 0x20a6;

const readable = (text: string): boolean => {
  const characters = [...text];
  if (characters.length < MIN_LENGTH) return false;
  let ordinary = 0;
  for (const character of characters) {
    if (isOrdinary(character.codePointAt(0) ?? 0)) ordinary += 1;
  }
  return ordinary / characters.length >= LEGIBLE_RATIO;
};

const OCTAL = /^[0-7]/;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  "(": "(",
  ")": ")",
  "\\": "\\",
};

/**
 * One PDF string literal, from the byte after `(` to its matching `)`.
 *
 * Parentheses nest inside a literal without being escaped, so the depth has to be tracked. The
 * obvious alternative — stopping at the first `)` — truncates every sentence containing a
 * bracket, which in a price list is most of them.
 */
const readLiteral = (
  raw: string,
  from: number,
): { readonly text: string; readonly next: number } => {
  const out: string[] = [];
  let depth = 1;
  let at = from;

  while (at < raw.length) {
    const character = raw[at] ?? "";

    if (character === "\\") {
      const escaped = raw[at + 1] ?? "";
      if (OCTAL.test(escaped)) {
        const digits = raw.slice(at + 1, at + 4).match(/^[0-7]{1,3}/)?.[0] ?? "";
        out.push(String.fromCharCode(Number.parseInt(digits, 8)));
        at += 1 + digits.length;
        continue;
      }
      // A backslash before a newline is a line continuation and contributes no character.
      if (escaped !== "\n") out.push(SIMPLE_ESCAPES[escaped] ?? escaped);
      at += 2;
      continue;
    }

    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return { text: out.join(""), next: at + 1 };
    }
    out.push(character);
    at += 1;
  }

  return { text: out.join(""), next: at };
};

const readHex = (raw: string, from: number): { readonly text: string; readonly next: number } => {
  const end = raw.indexOf(">", from);
  if (end === -1) return { text: "", next: raw.length };
  const digits = raw.slice(from, end).replace(/[^0-9a-fA-F]/g, "");
  const out: string[] = [];
  for (let at = 0; at + 1 < digits.length; at += 2) {
    out.push(String.fromCharCode(Number.parseInt(digits.slice(at, at + 2), 16)));
  }
  return { text: out.join(""), next: end + 1 };
};

/**
 * The strings a content stream paints, with the operators that move the pen turned into
 * newlines.
 *
 * `Td`, `TD`, `T*` and `Tm` all move to a new position, and a visual line of text is usually
 * one of those followed by one string, so treating them as line breaks is what stops a page
 * arriving as a single unbroken run. In a `TJ` array the bare numbers are kerning in
 * thousandths of an em; a large negative one is a word space the file never wrote as a
 * character, which is why it becomes one here.
 */
const textFromStream = (raw: string): string => {
  const out: string[] = [];
  let at = 0;
  let inText = false;

  while (at < raw.length) {
    const character = raw[at] ?? "";

    if (!inText) {
      if (raw.startsWith("BT", at)) {
        inText = true;
        at += 2;
        continue;
      }
      at += 1;
      continue;
    }

    if (raw.startsWith("ET", at)) {
      inText = false;
      out.push("\n");
      at += 2;
      continue;
    }

    if (character === "(") {
      const { text, next } = readLiteral(raw, at + 1);
      out.push(text);
      at = next;
      continue;
    }

    // `<<` opens a dictionary; a lone `<` opens a hex string.
    if (character === "<" && raw[at + 1] !== "<") {
      const { text, next } = readHex(raw, at + 1);
      out.push(text);
      at = next;
      continue;
    }

    if (
      raw.startsWith("Td", at) ||
      raw.startsWith("TD", at) ||
      raw.startsWith("T*", at) ||
      raw.startsWith("Tm", at)
    ) {
      out.push("\n");
      at += 2;
      continue;
    }

    if (character === "-" && /^-\d{3,}/.test(raw.slice(at, at + 8))) {
      out.push(" ");
      at += 1;
      continue;
    }

    at += 1;
  }

  return out.join("");
};

/**
 * Every stream in the file that looks like it paints text.
 *
 * Found by scanning rather than by following the cross-reference table, because that table is
 * the part of a PDF most likely to be subtly wrong in a file produced by a tool nobody has
 * heard of — and it is not needed to answer "which of these blobs contain words". Anything
 * that inflates into something with no text operators in it is a font or an image, and is
 * skipped.
 */
const contentStreams = (bytes: Buffer): readonly string[] => {
  const out: string[] = [];
  const haystack = bytes.toString("latin1");
  let at = haystack.indexOf("stream");

  while (at !== -1) {
    let from = at + "stream".length;
    if (haystack[from] === "\r") from += 1;
    if (haystack[from] === "\n") from += 1;

    const end = haystack.indexOf("endstream", from);
    if (end === -1) break;

    const slice = bytes.subarray(from, end);
    let text: string;

    try {
      text = inflateSync(slice).toString("latin1");
    } catch {
      // Not deflated, or deflated with a filter we do not do. An uncompressed content stream
      // is legal and common in small files, so the raw bytes are still worth a look.
      text = slice.toString("latin1");
    }

    if (text.includes("BT") && (text.includes("Tj") || text.includes("TJ"))) out.push(text);

    at = haystack.indexOf("stream", end + "endstream".length);
  }

  return out;
};

export interface PdfText {
  readonly text: string;
  /** Set when the file was read but what came out of it could not be trusted. */
  readonly refusal: string | null;
}

export const extractPdf = (bytes: Buffer): PdfText => {
  const streams = contentStreams(bytes);

  if (streams.length === 0) {
    return {
      text: "",
      refusal:
        "This PDF has no text in it — it is most likely a scan of a printed page. Type or paste the text in, or upload the document it was printed from.",
    };
  }

  const text = streams
    .map((stream) => textFromStream(stream))
    .join("\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!readable(text)) {
    return {
      text: "",
      refusal:
        "This PDF uses embedded fonts we cannot map back to letters, so anything pulled out of it would be nonsense read down the phone. Paste the text in instead.",
    };
  }

  return { text, refusal: null };
};
