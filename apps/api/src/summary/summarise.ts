/**
 * What a call came to, in a few sentences, each one pointing at the words behind it.
 *
 * This is the first model output in the product that is written down rather than spoken, and
 * the difference matters: a spoken turn is heard once by somebody who was there, and this is
 * read later by somebody who was not, deciding what to do about a customer. It has to be
 * answerable for.
 *
 * **Grounding is enforced here, not asked for in the prompt.** The prompt says to cite; this
 * module drops any sentence whose citations do not resolve to lines of this call. A prompt can
 * be talked out of things and a filter cannot — the same reason risk tiers live in the dispatch
 * path rather than in an instruction. A model that invents a citation loses the sentence, and
 * one that invents a whole call produces nothing at all, which is the correct output for a call
 * it did not read.
 */

/** One line of the conversation, as the summariser sees it. */
export interface SummaryLine {
  readonly id: string;
  readonly speaker: "caller" | "agent";
  readonly text: string;
}

export interface Summary {
  /** Sentences, in order, joined. Empty when nothing survived grounding. */
  readonly summary: string;
  /** One entry per sentence: the transcript ids it rests on. */
  readonly cites: readonly (readonly string[])[];
}

export const EMPTY: Summary = { summary: "", cites: [] };

/** Bumped when the wording below changes, so a batch can be found and re-run. See 0079. */
export const PROMPT_VERSION = 1;

/**
 * How many sentences are worth reading.
 *
 * Four. Somebody opening a call wants to know what it was about and what came of it; the
 * transcript is directly underneath for everything else, and a summary long enough to need
 * skimming has failed at the one job it has.
 */
const MAX_SENTENCES = 4;

export const buildSummaryPrompt = (lines: readonly SummaryLine[]): string =>
  [
    "Summarise this phone call for a colleague who was not on it.",
    "",
    "Rules:",
    `- At most ${MAX_SENTENCES} sentences, in the order things happened.`,
    "- Every sentence must cite the line ids it comes from. A sentence you cannot cite is a",
    "  sentence you must not write.",
    "- Say what the caller wanted and what came of it. Do not give advice, do not guess at",
    "  what anybody felt, and do not repeat the whole conversation.",
    "- Use the caller's own words for anything they confirmed — a name, a time, an amount.",
    "",
    'Reply with JSON only: {"sentences":[{"text":"...","cites":["12","13"]}]}',
    "",
    "The call:",
    ...lines.map(
      (line) => `[${line.id}] ${line.speaker === "agent" ? "Agent" : "Caller"}: ${line.text}`,
    ),
  ].join("\n");

/** The first JSON object in a reply, because a model will sometimes wrap it in prose. */
const firstObject = (reply: string): unknown => {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(reply.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * A model's reply into a summary, keeping only what it can point at.
 *
 * Every rejection here is deliberate rather than defensive tidying:
 *
 * - a sentence with no citations is an assertion with no evidence;
 * - a citation naming a line this call does not have is the shape a hallucination takes, and
 *   the sentence around it cannot be trusted either;
 * - more than four sentences means the model ignored the brief, and the tail is where it
 *   starts inventing.
 */
export const parseSummary = (reply: string, lines: readonly SummaryLine[]): Summary => {
  const known = new Set(lines.map((line) => line.id));
  const parsed = firstObject(reply);
  if (!isRecord(parsed) || !Array.isArray(parsed["sentences"])) return EMPTY;

  const text: string[] = [];
  const cites: string[][] = [];

  for (const raw of parsed["sentences"].slice(0, MAX_SENTENCES)) {
    if (!isRecord(raw)) continue;
    const sentence = typeof raw["text"] === "string" ? raw["text"].trim() : "";
    if (sentence === "") continue;

    const claimed = Array.isArray(raw["cites"]) ? raw["cites"].map(String) : [];
    const resolved = claimed.filter((id) => known.has(id));
    // Every citation has to land. One that does not is a line the model believed it read.
    if (resolved.length === 0 || resolved.length !== claimed.length) continue;

    text.push(sentence);
    cites.push(resolved);
  }

  return { summary: text.join(" "), cites };
};
