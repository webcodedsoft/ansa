import { readZipEntry } from "./zip";

/**
 * The words out of a Word document.
 *
 * WordprocessingML is verbose but the part that carries text is small: `<w:t>` holds runs of
 * characters, `<w:p>` bounds a paragraph, `<w:tab/>` and `<w:br/>` are what they look like.
 * Everything else in the file — styles, revision ids, section properties, the theme — says how
 * it should look on a page, and this is going to be read down a phone line, so none of it
 * survives the trip.
 *
 * Tables become tab-separated rows on purpose. That is exactly the shape `parseUnits` reads as
 * a table, so a price list written in Word lands as one retrievable fact per row rather than as
 * one enormous paragraph.
 */

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const decodeXml = (text: string): string =>
  text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return ENTITIES[body] ?? whole;
  });

/**
 * Walk the tags in order and keep only the ones that produce characters.
 *
 * A scan over tags rather than a parser, because the question being asked is "what did this
 * say", in document order, and every construct that matters is one self-contained tag. The
 * opening `w:t` is matched loosely because of `<w:t xml:space="preserve">`: a leading space in
 * a run is meaningful, and dropping the attribute would join two words into one.
 */
const textOf = (xml: string): string => {
  /* Paragraphs are separated by a blank line and table rows are not, and that difference is
     the whole point of this function. `parseUnits` splits a document on blank lines and a
     table on newlines, so getting this wrong turns a page of prose into one giant passage, or
     a price list into one row. */
  const lines: string[] = [];
  let current: string[] = [];
  let inRow = false;

  const take = (): string => {
    const line = current.join("").replace(/[ \t]+$/, "");
    current = [];
    return line;
  };

  const tags = /<([^>]+)>([^<]*)/g;
  let match = tags.exec(xml);

  while (match !== null) {
    const tag = match[1] ?? "";
    const between = match[2] ?? "";
    const closing = tag.startsWith("/");
    const name = (closing ? tag.slice(1) : tag).split(/[\s/>]/)[0] ?? "";

    if (!closing && name === "w:t") current.push(decodeXml(between));
    else if (name === "w:tab") current.push("\t");
    else if (name === "w:br" || name === "w:cr") current.push("\n");
    else if (name === "w:tbl") lines.push("");
    else if (!closing && name === "w:tr") inRow = true;
    else if (closing && name === "w:tc") {
      // The cell's own last paragraph break left a space behind, and it would otherwise end up
      // inside the value: "Branch " rather than "Branch".
      current = [current.join("").replace(/[ \t]+$/, ""), "\t"];
    }
    else if (closing && name === "w:tr") {
      // The row is the unit, so its cells stay on one line and the trailing separator goes.
      const row = take().replace(/\t$/, "");
      if (row.trim() !== "") lines.push(row);
      inRow = false;
    } else if (closing && name === "w:p") {
      if (inRow) {
        // A cell holding two paragraphs must not split its row in half, so the break inside
        // one becomes a space.
        current.push(" ");
      } else {
        const line = take();
        if (line !== "") lines.push(line, "");
      }
    }

    match = tags.exec(xml);
  }

  const last = take();
  if (last !== "") lines.push(last);

  return lines
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

/** The document's text, or null if this is not a readable .docx. */
export const extractDocx = (bytes: Buffer): string | null => {
  const document = readZipEntry(bytes, "word/document.xml");
  if (document === null) return null;
  const text = textOf(document.toString("utf8"));
  return text === "" ? null : text;
};
