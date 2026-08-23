import type { PolicyBlock } from "./components/policy-tab";

/**
 * Policies as a document, and back again.
 *
 * The Policies tab offers two views of one thing: a split view with fields, and a prompt-first
 * view where you edit the block the model receives. A button swaps between them, so both
 * directions have to be trustworthy — and they are not symmetrical.
 *
 * **Structure is canonical.** `policyBlocks` reaches the API as an array of objects, so the
 * document is a *rendering* of the data rather than the other way round. Rendering is total:
 * every block produces exactly one document and nothing is lost. Parsing is not — a person can
 * type something that is not a policy at all.
 *
 * So the contract is round-trip stability in the direction that matters:
 *
 *     parse(render(blocks)) === blocks        for every block the editor can produce
 *     render(parse(text))   === normalised    for every text that parses at all
 *
 * and `parse` reports what it could not place instead of dropping it. The view refuses to swap
 * while anything is unplaced, which is what makes the button safe: the alternative is a toggle
 * that quietly eats the sentence somebody just typed.
 */

/** The four headings, in the order they render. The set is closed on purpose — see `parse`. */
const SECTIONS = [
  { heading: "Applies when", key: "applies" },
  { heading: "Can", key: "canDo" },
  { heading: "Must not", key: "cannotDo" },
  { heading: "Hand over when", key: "escalateWhen" },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

const LIST_KEYS = ["canDo", "cannotDo", "escalateWhen"] as const;

export interface PolicyTextProblem {
  /** 1-based, so it matches what an editor's gutter would show. */
  readonly line: number;
  readonly message: string;
}

export interface ParsedPolicies {
  readonly blocks: readonly PolicyBlock[];
  /** Empty when the document is clean. Non-empty disables the swap — see the header. */
  readonly problems: readonly PolicyTextProblem[];
}

/**
 * Blank sections are written out, not skipped.
 *
 * A document that omits "Must not" when a policy has none is shorter and worse: somebody
 * editing it has nowhere to type the first one, and would have to know the heading exists. In
 * this view the headings are the form.
 */
export const renderPolicies = (blocks: readonly PolicyBlock[]): string =>
  blocks
    .map((block) => {
      const lines: string[] = [`## ${block.name}`, "", "Applies when", block.applies, ""];
      for (const key of LIST_KEYS) {
        const heading = SECTIONS.find((section) => section.key === key)?.heading ?? "";
        lines.push(heading, ...block[key].map((entry) => `- ${entry}`), "");
      }
      return lines.join("\n").trimEnd();
    })
    .join("\n\n");

const emptyBlock = (name: string): PolicyBlock => ({
  name,
  applies: "",
  canDo: [],
  cannotDo: [],
  escalateWhen: [],
});

const headingFor = (line: string): SectionKey | null =>
  SECTIONS.find((section) => section.heading.toLowerCase() === line.trim().toLowerCase())?.key ??
  null;

export const parsePolicies = (text: string): ParsedPolicies => {
  const blocks: PolicyBlock[] = [];
  const problems: PolicyTextProblem[] = [];

  let current: PolicyBlock | null = null;
  let section: SectionKey | null = null;

  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    const at = index + 1;

    if (line === "") continue;

    if (line.startsWith("##")) {
      const name = line.replace(/^#+/, "").trim();
      if (name === "") {
        problems.push({ line: at, message: "This policy has no name after the ##." });
      }
      current = emptyBlock(name);
      blocks.push(current);
      section = null;
      continue;
    }

    if (current === null) {
      /* Text above the first `##`. Reported rather than swallowed: it is usually somebody's
         note to themselves, and losing it on a view swap is the failure this guards. */
      problems.push({
        line: at,
        message: "This sits above the first policy. Start a policy with ## and a name.",
      });
      continue;
    }

    const named = headingFor(line);
    if (named !== null) {
      section = named;
      continue;
    }

    if (section === null) {
      problems.push({
        line: at,
        message: `This sits under no heading. Put it under ${SECTIONS.map((s) => `“${s.heading}”`).join(", ")}.`,
      });
      continue;
    }

    if (section === "applies") {
      /* Joined rather than replaced, so a sentence wrapped across two lines survives. The
         renderer always writes it on one, so this only matters for text somebody typed. */
      current.applies = current.applies === "" ? line : `${current.applies} ${line}`;
      continue;
    }

    const entry = line.startsWith("- ") ? line.slice(2).trim() : line;
    if (entry === "") continue;
    current[section].push(entry);
  }

  return { blocks, problems };
};

/** Whether a swap would change anything. Used by the round-trip test and by the toggle. */
export const samePolicies = (
  left: readonly PolicyBlock[],
  right: readonly PolicyBlock[],
): boolean => JSON.stringify(left) === JSON.stringify(right);
