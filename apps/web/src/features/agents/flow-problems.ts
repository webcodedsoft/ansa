/**
 * What is wrong with a conversation graph, said to the person who drew it.
 *
 * The validator supplies the sentence; this module supplies the subject and the order. A
 * validator message reads "the caller answers and nothing happens next" and carries a
 * `nodeId` — on its own that is a consequence with nobody attached to it, and the operator
 * has to hunt the canvas for which of nine cards it means. Naming the step in front of the
 * message is the whole job: "Asks for policyNumber — the caller answers and nothing happens
 * next."
 *
 * Which is also why "node n7" never appears. An id is what the graph calls a step; an
 * operator has never seen one and cannot find one. Every entry either names a step in the
 * words the canvas uses for it, or says it is about the flow as a whole.
 *
 * Pure and separate from the two components that render it, in the shape `policy-lines.ts`
 * already uses beside `policy-lines.test.ts`. Not a preference: this app compiles JSX with
 * `jsx: "preserve"`, so Vite cannot transform a `.tsx` and a test cannot import one. Logic
 * that lives in a component file is logic with no tests.
 */

/**
 * `FlowNode` and `FlowProblem` from `@ansa/shared`, structurally.
 *
 * `apps/web` does not depend on `@ansa/shared` — nothing in `src/` imports it and it is not
 * in the package's dependencies — so these are declared rather than imported, and kept loose
 * enough that the real types are assignable to them. `code` is `string` on purpose: nothing
 * here keys off it, and mirroring an eleven-member union would only give it a way to drift.
 * `kind` is mirrored exactly, because `stepLabel` switches on it and a missing arm should be
 * a compile error rather than a step with no name.
 */
export type FlowStepKind =
  | "start" | "say" | "collect" | "confirm" | "decide" | "tool" | "transfer" | "hangup";

export interface FlowStepLike {
  readonly id: string;
  readonly kind: FlowStepKind;
  /** `say` only. */
  readonly text?: string;
  /** `tool` only. */
  readonly tool?: string;
  /** `decide` and `confirm` only — the field key the step reads. */
  readonly on?: string;
  /** `collect` only. Wider than `FlowField` so the real one is assignable. */
  readonly field?: { readonly key: string };
}

export interface FlowProblemLike {
  readonly nodeId: string | null;
  readonly code: string;
  readonly message: string;
  readonly blocking: boolean;
}

/** A problem with its step already resolved. `step` is null when it is about the graph itself. */
export interface ProblemEntry {
  readonly problem: FlowProblemLike;
  readonly step: FlowStepLike | null;
}

/** Enough of a `say` line to recognise it, and never enough to wrap the row. */
const clip = (text: string, max = 34): string => {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

const present = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

/**
 * A step, named the way the canvas names it.
 *
 * Verb-first and about the call, so the label and the consequence beside it read as one
 * sentence. Field keys and tool names go through verbatim — they are what the operator typed
 * into the field builder, so they are what they will scan the canvas for.
 *
 * The fallbacks are load-bearing rather than defensive: a half-built step is exactly the kind
 * a problem points at, and it still has to be nameable. They never restate the problem, which
 * is the message's job and would otherwise be said twice on one row.
 *
 * No `default` arm: an exhaustive switch means adding a ninth node kind fails the build here
 * rather than shipping a card labelled with nothing.
 */
export const stepLabel = (step: FlowStepLike): string => {
  switch (step.kind) {
    case "start":
      return "Call answered";
    case "say":
      return present(step.text) ? `Says “${clip(step.text)}”` : "Says something";
    case "collect":
      return step.field !== undefined ? `Asks for ${step.field.key}` : "Asks a question";
    case "confirm":
      return present(step.on) ? `Confirms ${step.on}` : "Confirms a value";
    case "decide":
      return present(step.on) ? `Branches on ${step.on}` : "Branches";
    case "tool":
      return present(step.tool) ? `Calls ${step.tool}` : "Calls a tool";
    case "transfer":
      return "Transfers to a person";
    case "hangup":
      return "Ends the call";
  }
};

/** The subject line for a problem that belongs to no single step. */
export const WHOLE_FLOW_LABEL = "This flow";

/**
 * Blocking first, then in the order the steps sit in the graph.
 *
 * Blocking first because the list is a queue: the things that refuse a publish are the things
 * to do, and a warning above them costs a read to skip. Canvas order second because the graph
 * is stored roughly in call order, so the queue walks the call rather than jumping about.
 * Problems with no step — no start, too many fields — sort to the head of their group, since
 * they are about the thing the rest sit inside.
 *
 * The original index is the last tiebreak rather than trusting a stable sort, so two problems
 * on one step keep the order the validator emitted them in whatever the runtime does.
 */
export const orderProblems = (
  problems: readonly FlowProblemLike[],
  steps: readonly FlowStepLike[],
): readonly ProblemEntry[] => {
  const byId = new Map(steps.map((step, index) => [step.id, { step, index }] as const));
  return problems
    .map((problem, index) => {
      const found = problem.nodeId === null ? undefined : byId.get(problem.nodeId);
      // An id with no step left on the canvas is treated as a whole-flow problem: it still has
      // a real sentence to show, and pretending it is clickable would give the operator a
      // control that selects nothing.
      return { problem, step: found?.step ?? null, rank: found?.index ?? -1, index };
    })
    .sort(
      (a, b) =>
        Number(b.problem.blocking) - Number(a.problem.blocking) || a.rank - b.rank || a.index - b.index,
    )
    .map(({ problem, step }) => ({ problem, step }));
};

/** "1 step", "6 steps", "2 branches". `many` exists because English does not always add an s. */
export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/**
 * What is on the canvas, counted in things an operator can point at.
 *
 * Steps is every node, the start card included, so the number matches what they can count on
 * screen. Questions and branches are dropped at zero rather than shown as "0 questions" — a
 * flow that asks nothing is a fine flow, and a row of zeroes reads as a list of failures.
 *
 * Deliberately not "paths". A path count is either the number of routes through the graph,
 * which is unbounded once anything loops, or the number of endings, or the number of branch
 * points — three different numbers behind one word, none of which the operator can check by
 * counting cards. "Branches" is the decide steps, and those are cards they can see.
 */
export const flowSummary = (steps: readonly FlowStepLike[]): string => {
  const questions = steps.filter((step) => step.kind === "collect").length;
  const branches = steps.filter((step) => step.kind === "decide").length;
  const parts = [plural(steps.length, "step")];
  if (questions > 0) parts.push(plural(questions, "question"));
  if (branches > 0) parts.push(plural(branches, "branch", "branches"));
  return parts.join(" · ");
};

/** Matches `Tone` in `components/ui`, without this module having to import a component kit. */
export type FlowStatusTone = "ok" | "warn" | "bad";

export interface FlowStatusLine {
  readonly tone: FlowStatusTone;
  /** The verdict — "1 problem · cannot publish". */
  readonly label: string;
  /** The neutral count of what is on the canvas — "6 steps · 4 questions". */
  readonly summary: string;
}

/**
 * The verdict, in three states.
 *
 * Blocking wins outright: if a publish would be refused, the count of things that would still
 * be nice to fix is not what the line is for. "cannot publish" is spelled out beside the count
 * because "3 problems" on its own leaves open whether they are fatal, and the answer to that
 * is the only thing anybody needs from this line in a hurry. "ready to publish" is the other
 * end of the same axis, so the line reads as one question answered rather than two moods.
 */
export const flowStatusLine = (
  steps: readonly FlowStepLike[],
  problems: readonly FlowProblemLike[],
): FlowStatusLine => {
  const blocking = problems.filter((problem) => problem.blocking).length;
  const warnings = problems.length - blocking;
  const summary = flowSummary(steps);
  if (blocking > 0) return { tone: "bad", label: `${plural(blocking, "problem")} · cannot publish`, summary };
  if (warnings > 0) return { tone: "warn", label: plural(warnings, "warning"), summary };
  return { tone: "ok", label: "ready to publish", summary };
};
