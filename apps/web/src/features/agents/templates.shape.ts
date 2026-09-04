import type { CapturedField } from "./agents.schema";

/**
 * The shape of a template, and the one constructor every template uses.
 *
 * On its own so the catalogue and the founding five can both import it without either
 * importing the other: a circular import between two modules that call `field` at load
 * time is a `field is not defined` at the worst possible moment.
 */

export interface AgentTemplate {
  readonly id: string;
  readonly name: string;
  /** The kind of organisation this is for — the gallery groups and filters by it. */
  readonly sector: string;
  /** One line, shown on the card. What this agent is for, not how it works. */
  readonly summary: string;
  readonly persona: string;
  readonly greeting: string;
  readonly instructions: string;
  /** In the order the caller is asked, because order is the conversation. */
  readonly fields: readonly CapturedField[];
  /**
   * Where the conversation forks, for a template used in the flow builder.
   *
   * `on` names a `choice` in `fields`; each arm is the questions that follow one of its
   * options, and every arm rejoins before the close. This is what makes a template a
   * complete flow rather than a line: "rent or buy" leads to different questions, and a
   * caller who said rent is never asked about a deposit. The form builder asks the arms'
   * questions too, marked optional, since a list cannot skip.
   */
  readonly branch?: TemplateBranch;
  /** What the agent covers before hanging up — what happens next, in the caller's terms. */
  readonly closing?: string;
  readonly bargeIn: boolean;
  readonly answeringMachineDetection: boolean;
}

export interface TemplateBranch {
  readonly on: string;
  readonly arms: Readonly<Record<string, readonly CapturedField[]>>;
}

/** Every question a template asks, arms included, for the form builder and the previews. */
export const allFields = (template: AgentTemplate): readonly CapturedField[] => [
  ...template.fields,
  ...(template.branch === undefined
    ? []
    : Object.values(template.branch.arms)
        .flat()
        .map((field) => ({ ...field, required: false }))),
];

/**
 * A field with the safe defaults filled in.
 *
 * The defaults are the cautious reading — captured by speech, unconfirmed, three attempts —
 * so a template only has to name what it actually wants to be different. Anything that ends
 * up confirmed below says so explicitly, which is how it should read: confirmation is the
 * decision worth seeing.
 */
export const field = (
  key: string,
  type: CapturedField["type"],
  prompt: string,
  over: Partial<CapturedField> = {},
): CapturedField => ({
  key,
  type,
  prompt,
  capture: "speech",
  confirm: "none",
  pattern: "",
  attempts: 3,
  required: true,
  options: [],
  ...over,
});

