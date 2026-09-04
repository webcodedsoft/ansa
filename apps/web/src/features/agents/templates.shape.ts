import type { CapturedField } from "./agents.schema";

/**
 * The shape of a template, and the one constructor every template uses.
 *
 * On its own so the catalogue and the founding few can both import it without either
 * importing the other: a circular import between two modules that call `field` at load
 * time is a `field is not defined` at the worst possible moment.
 */

/**
 * One organisation's whole front desk.
 *
 * Not one task. An estate agency's line takes enquiries, books viewings, logs faults and
 * fields rent questions, and knows which of those a machine must not settle; a template is
 * that line. The opening is shared — who is calling, and what about — and the reason forks
 * into services, each a complete sub-conversation that may fork again and ends either with
 * what happens next or with a hand-over to a person.
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
  /**
   * Words the transcriber is told to expect: places, products, the things callers say that
   * an American-English model has never heard. Boosted, not merely hinted, so only words a
   * caller of this business is likely to say — a list of everything is a list of nothing.
   */
  readonly keyterms: readonly string[];
  /**
   * What the agent may do, must not do, and when it hands over — per situation, read on
   * every turn. This is where a template stops being a form and starts being a business:
   * the refund rule, the "never quote a price from memory", the "an emergency goes to a
   * person now".
   */
  readonly policies: readonly TemplatePolicy[];
  /** Asked of everyone, in this order, because order is the conversation. */
  readonly fields: readonly CapturedField[];
  /**
   * Where the conversation forks. `on` names a `choice` in `fields`; each arm is one
   * service. A form agent asks every arm's questions, marked optional, with a policy that
   * says which belong to which service — a list cannot skip, so it is told what to skip.
   */
  readonly branch?: TemplateBranch;
  /** What the agent covers before hanging up, on any path without its own closing. */
  readonly closing?: string;
  readonly bargeIn: boolean;
  readonly answeringMachineDetection: boolean;
}

export interface TemplatePolicy {
  readonly name: string;
  readonly applies: string;
  readonly canDo: readonly string[];
  readonly cannotDo: readonly string[];
  readonly escalateWhen: readonly string[];
}

export interface TemplateBranch {
  readonly on: string;
  /** Keyed by the option that leads there; the last option is the catch-all on the canvas. */
  readonly arms: Readonly<Record<string, TemplateArm>>;
}

/**
 * One service, as a sub-conversation.
 *
 * `handover` and `closing` are both instructions, not scripts, and they are exclusive: an
 * arm either ends the call with what happens next or puts the caller through to a person
 * with a word about why. An arm with neither rejoins the template's own closing.
 */
export interface TemplateArm {
  readonly fields: readonly CapturedField[];
  readonly branch?: TemplateBranch;
  readonly closing?: string;
  readonly handover?: string;
}

const armFields = (arm: TemplateArm): readonly CapturedField[] => [
  ...arm.fields,
  ...(arm.branch === undefined ? [] : Object.values(arm.branch.arms).flatMap(armFields)),
];

/** Every question a template asks, every arm and fork included, for the form and the previews. */
export const allFields = (template: AgentTemplate): readonly CapturedField[] => [
  ...template.fields,
  ...(template.branch === undefined
    ? []
    : Object.values(template.branch.arms)
        .flatMap(armFields)
        .map((field) => ({ ...field, required: false }))),
];

/** The services a template's front desk handles — the top-level arms, in order. */
export const servicesOf = (template: AgentTemplate): readonly string[] =>
  template.branch === undefined ? [] : Object.keys(template.branch.arms);

/**
 * The policies a form agent gets: the template's own, plus one that says which questions
 * belong to which service.
 *
 * A flow asks a service's questions only on that service's arm and needs no such thing. A
 * form is a list, and a list of thirty optional questions is a list the model will march
 * through unless it is told the shape of the business — so the shape is written down as a
 * policy, which is read every turn, rather than buried in the instructions.
 */
export const formPolicies = (template: AgentTemplate): readonly TemplatePolicy[] => {
  if (template.branch === undefined) return template.policies;
  const on = template.fields.find((field) => field.key === template.branch?.on);
  /* One line per service, within the API's 200 characters. A service that forks again
     names its own questions and points at the fork rather than listing every arm's keys,
     which is both shorter and how the model should think about it. */
  const lines = Object.entries(template.branch.arms).map(([service, arm]) => {
    const own = arm.fields.map((field) => field.key);
    const then = arm.branch === undefined ? "" : `, then the questions for their answer to ${arm.branch.on}`;
    const line =
      own.length === 0 && then === ""
        ? `If they are calling about "${service}": nothing more to ask — go to the close.`
        : `If they are calling about "${service}": ask only ${own.length === 0 ? "the fork question" : own.join(", ")}${then}.`;
    return line.length <= 200 ? line : `${line.slice(0, 197)}…`;
  });
  return [
    ...template.policies,
    {
      name: "Which questions to ask",
      applies: `Every call. What you ask depends on their answer to "${on?.prompt ?? template.branch.on}".`,
      canDo: lines.slice(0, 8),
      cannotDo: ["Ask a question that belongs to a service they did not call about."],
      escalateWhen: [],
    },
  ];
};

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
