import { z } from "zod";

/**
 * Turning something an operator pasted into the pieces retrieval will return.
 *
 * The parsing lives here, in front of a preview, rather than behind an upload on the server.
 * A unit is what retrieval returns and therefore what a caller hears, so a bad split is
 * somebody being read half a sentence — and the only moment that is cheap to notice is
 * before it is saved. The API takes units already split, deliberately, for the same reason.
 */

export const KINDS = ["faq", "table", "document"] as const;
export type Kind = (typeof KINDS)[number];

export interface DraftUnit {
  readonly question: string | null;
  readonly body: string;
}

export const KIND_LABEL: Readonly<Record<Kind, string>> = {
  faq: "Question and answer pairs",
  table: "A table — one row at a time",
  document: "A document — split into passages",
};

export const KIND_HINT: Readonly<Record<Kind, string>> = {
  faq: "One pair per block: the question on the first line, the answer under it, a blank line between pairs.",
  table: "Paste from a spreadsheet. The first row is the column names; every row after it becomes one retrievable fact.",
  document: "Paste the text. It splits on blank lines, and a short line on its own is treated as a heading and kept with what follows.",
};

/** Roughly what a caller would be read — how a unit is shown in the preview. */
export const spokenForm = (unit: DraftUnit): string =>
  unit.question === null ? unit.body : `${unit.question} — ${unit.body}`;

const blocks = (raw: string): readonly string[] =>
  raw
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "");

/**
 * A block, cut again wherever a new question starts.
 *
 * A blank line between pairs is what the hint asks for, and it is not what arrives. Text lifted
 * out of a PDF has one newline per printed line and no blank lines at all, so without this the
 * whole page is one block: the first question becomes the question and every other question and
 * answer on the page becomes its answer. One unit, read out in full, to whoever asked any of
 * them.
 */
const segmentsOf = (block: string): readonly (readonly string[])[] => {
  const out: string[][] = [];
  for (const line of block.split("\n").map((line) => line.trim()).filter((line) => line !== "")) {
    const last = out[out.length - 1];
    if (last === undefined || line.endsWith("?")) out.push([line]);
    else last.push(line);
  }
  return out;
};

/**
 * Question first, answer beneath.
 *
 * A segment with no answer is kept rather than dropped when it is a statement: it is still a
 * true thing the organisation wrote down, and losing it silently would be worse than retrieving
 * it with nothing to match the question against.
 *
 * A lone question is different — it is half of a fact, and stored by itself it retrieves for
 * exactly the caller it cannot help. So a question with nothing under it takes the next segment
 * as its answer, provided that segment is not itself a question. That is what a FAQ written in
 * Word looks like once extracted, where every paragraph is its own block, and it is what
 * somebody pasting with a blank line between question and answer meant. Two questions in a row
 * stay apart: that is a contents list, not a pair.
 */
const parseFaq = (raw: string): readonly DraftUnit[] => {
  const segments = blocks(raw).flatMap((block) => segmentsOf(block));
  const out: DraftUnit[] = [];

  for (let at = 0; at < segments.length; at += 1) {
    const [first, ...rest] = segments[at] ?? [];
    const answer = rest.join(" ").trim();

    if (answer !== "") {
      out.push({ question: first ?? null, body: answer });
      continue;
    }

    const next = segments[at + 1];
    const isQuestion = first?.endsWith("?") === true;
    if (isQuestion && next !== undefined && next[0]?.endsWith("?") !== true) {
      out.push({ question: first ?? null, body: next.join(" ").trim() });
      at += 1;
      continue;
    }

    out.push({ question: null, body: first ?? "" });
  }

  return out;
};

/** Tab first, then comma: a spreadsheet paste is tab-separated, a CSV file is not. */
const cells = (line: string): readonly string[] =>
  (line.includes("\t") ? line.split("\t") : line.split(",")).map((cell) => cell.trim());

/**
 * One row, one unit, rendered as `Column: value` pairs.
 *
 * Rendered rather than kept as columns because retrieval is full-text and a caller asks
 * "what time does the Ikeja branch close", not "select closing_time where branch". Carrying
 * the column names into the body is what lets that question match the row at all.
 */
const parseTable = (raw: string): readonly DraftUnit[] => {
  const lines = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const [header, ...rows] = lines;
  if (header === undefined || rows.length === 0) return [];

  const columns = cells(header);
  return rows.map((row) => {
    const values = cells(row);
    const body = columns
      .map((column, index) => {
        const value = values[index] ?? "";
        return value === "" ? null : `${column}: ${value}`;
      })
      .filter((pair): pair is string => pair !== null)
      .join(". ");
    // The first column usually names the thing — the branch, the product — which makes it
    // the most useful question to match against.
    return { question: values[0] ?? null, body };
  });
};

/** Short enough to be a heading rather than a sentence, and not punctuated like one. */
const looksLikeHeading = (line: string): boolean =>
  line.length <= 60 && !/[.!?]$/.test(line) && line.split(" ").length <= 9;

/**
 * Passages, with a heading kept attached to what it introduces.
 *
 * A heading retrieved alone answers nothing — "Cancellations" is not a fact — and the
 * passage under it retrieved without it loses the one word a caller is most likely to say.
 * So the heading becomes the question and the passage the body, which is the shape a FAQ
 * pair already has and the shape retrieval ranks.
 */
const parseDocument = (raw: string): readonly DraftUnit[] => {
  const out: DraftUnit[] = [];
  let heading: string | null = null;

  for (const block of blocks(raw)) {
    if (!block.includes("\n") && looksLikeHeading(block)) {
      heading = block;
      continue;
    }
    out.push({ question: heading, body: block.replace(/\n/g, " ") });
    heading = null;
  }

  // A heading with nothing under it is still something somebody wrote, so it is kept for the
  // same reason a lone FAQ line is.
  if (heading !== null) out.push({ question: null, body: heading });
  return out;
};

export const parseUnits = (kind: Kind, raw: string): readonly DraftUnit[] => {
  if (raw.trim() === "") return [];
  if (kind === "faq") return parseFaq(raw);
  if (kind === "table") return parseTable(raw);
  return parseDocument(raw);
};

/** Mirrors the API's own bounds, so a refusal lands on a field rather than on the save. */
const MAX_BODY = 4000;
const MAX_UNITS = 2000;

export const problemsWith = (
  name: string,
  units: readonly DraftUnit[],
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};

  if (name.trim() === "") out["name"] = "Name it, so somebody can tell it from the others later.";
  else if (name.length > 120) out["name"] = "That name is too long — 120 characters at most.";

  if (units.length === 0) {
    out["content"] = "Nothing to store yet. Paste something and check the preview below.";
  } else if (units.length > MAX_UNITS) {
    out["content"] = `That is ${units.length} pieces; ${MAX_UNITS} is the most one source can hold.`;
  } else {
    const long = units.findIndex((unit) => unit.body.length > MAX_BODY);
    if (long !== -1) {
      /* Not an arbitrary bound: a unit is read aloud, and the model receives it whole with
         two sentences to answer in. Naming which piece is over is the difference between a
         fixable message and a wall of text somebody has to bisect by hand. */
      out["content"] =
        `Piece ${long + 1} is ${units[long]?.body.length} characters. Split it — a unit is read out on a call, and ${MAX_BODY} is already long for that.`;
    }
  }
  return out;
};

export const knowledgeFormSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(KINDS),
  /** Already split by `parseUnits`, so the server stores what the preview showed. */
  unitsJson: z.string(),
});
