import { ACCEPTED_EXTENSIONS, MAX_UPLOAD_BYTES } from "./accepted";
import { extractDocx } from "./docx";
import { extractPdf } from "./pdf";

export { ACCEPTED_EXTENSIONS, MAX_UPLOAD_BYTES };

/**
 * A file somebody uploaded, turned into text — and then thrown away.
 *
 * Nothing here stores the document. The text is what a source holds, the text is what
 * retrieval searches, and the text is all an agent can read aloud, so keeping the original
 * would be keeping a second copy of a customer's data with no retention story attached and no
 * use for it. The bytes live in memory for as long as this function runs.
 *
 * The shape it returns is deliberately not "text or throw". A file this cannot read is an
 * ordinary thing that happens to an operator holding a scanned PDF, and it deserves a sentence
 * telling them what to do instead — not a stack trace, and not, far worse, a page of rubbish
 * that looks like it worked.
 */

export interface Extraction {
  readonly text: string;
  /** An operator-facing sentence. When set, `text` is empty and nothing should be stored. */
  readonly refusal: string | null;
  /** What the shape of the text suggests, for pre-selecting the splitter. */
  readonly suggests: "faq" | "table" | "document";
}

const extensionOf = (fileName: string): string => {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot).toLowerCase();
};

/**
 * Which splitter to offer, decided from the text rather than from the file type.
 *
 * A .csv is a table and a .docx usually is not, but a Word document holding nothing but a price
 * list is a table too, and an operator should not have to know that to get the right split.
 * Tabs or three-plus commas across most lines say table; several lines ending in a question
 * mark say question-and-answer pairs.
 */
const shapeOf = (text: string): Extraction["suggests"] => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length < 2) return "document";

  const separated = lines.filter((line) => line.includes("\t") || line.split(",").length >= 3);
  if (separated.length >= lines.length * 0.7) return "table";

  const questions = lines.filter((line) => line.endsWith("?"));
  if (questions.length >= 2 && questions.length >= lines.length * 0.2) return "faq";

  return "document";
};

/** The name a source gets when it came from a file: the file's own, without the extension. */
export const nameFromFile = (fileName: string): string => {
  const base = fileName.slice(0, fileName.length - extensionOf(fileName).length);
  return base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
};

export const extractText = (fileName: string, bytes: Buffer): Extraction => {
  const nothing = { text: "", suggests: "document" } as const;

  if (bytes.length === 0) return { ...nothing, refusal: "That file is empty." };
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return {
      ...nothing,
      refusal: `That file is ${Math.round(bytes.length / 1024 / 1024)} MB and ${MAX_UPLOAD_BYTES / 1024 / 1024} MB is the most we read in one go. Split it, or paste the part you need.`,
    };
  }

  const extension = extensionOf(fileName);

  if (extension === ".pdf") {
    const { text, refusal } = extractPdf(bytes);
    return refusal !== null
      ? { ...nothing, refusal }
      : { text, refusal: null, suggests: shapeOf(text) };
  }

  if (extension === ".docx") {
    const text = extractDocx(bytes);
    if (text === null) {
      return {
        ...nothing,
        refusal:
          "We could not read that as a Word document. If it is an older .doc, open it in Word and save it again as .docx.",
      };
    }
    return { text, refusal: null, suggests: shapeOf(text) };
  }

  if (extension === ".txt" || extension === ".md" || extension === ".csv" || extension === ".tsv") {
    /* Decoding as UTF-8 turns a Windows-1252 file into replacement characters rather than
       failing, so a result full of them is a file saved in another encoding. Worth saying so:
       the alternative is a source full of black diamonds that nobody can search. */
    // A byte-order mark survives the decode as U+FEFF and would otherwise sit invisibly at the
    // front of the first piece, where it defeats an exact-match search for the first word.
    const text = bytes.toString("utf8").replace(/^\ufeff/, "").trim();
    if (text === "") return { ...nothing, refusal: "That file has no text in it." };
    const damaged = (text.match(/�/g) ?? []).length;
    if (damaged > text.length * 0.02) {
      return {
        ...nothing,
        refusal:
          "That file is not saved as UTF-8, so its accented characters arrived as rubbish. Re-save it as UTF-8 and upload it again.",
      };
    }
    return { text, refusal: null, suggests: shapeOf(text) };
  }

  return {
    ...nothing,
    refusal: `We do not read ${extension === "" ? "files without an extension" : extension} files. Upload ${ACCEPTED_EXTENSIONS.join(", ")}, or paste the text in.`,
  };
};
