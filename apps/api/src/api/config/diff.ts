import type { AgentConfigFields } from "@ansa/db";
import type { Flow, FlowEdge, FlowNode } from "@ansa/shared";

/**
 * What changed between two published configurations.
 *
 * Pure — two snapshots in, a list of differences out — for the same reason `publication.ts`
 * is: the interesting part is the comparison, and a comparison that needs a database to test
 * is a comparison nobody tests exhaustively.
 *
 * The question this answers is "it was working yesterday, what did we change", which on a
 * voice agent is asked about a regression somebody *heard*. So the shape is a list of the
 * fields that moved rather than two whole configurations for the reader to eyeball: a
 * greeting and a persona are paragraphs, and a diff that makes somebody find the changed
 * sentence themselves is a diff they will stop opening.
 *
 * **Leaves, not objects.** `businessHours` and `escalation` are stored as three columns
 * each, and a caller who moved closing time by an hour wants to read that rather than two
 * JSON blobs. So the comparison descends into them and reports
 * `businessHours.closesAtHour`, with a null on whichever side did not have the object at
 * all — which is how "hours were turned off" reads as three fields clearing rather than as
 * one unexplained shape change.
 *
 * **Everything renders as text**, including the numbers. The response schema this feeds has
 * integers and strings and no way to say "either", and a per-type union would put four
 * nullable fields on every row for the sake of avoiding a `String()`. A rendered value is
 * what a diff shows anyway.
 */

/** One field that is not the same in both versions. Only differences are reported. */
export interface FieldChange {
  /** Dotted path into the configuration, e.g. `greeting` or `escalation.ringSeconds`. */
  readonly field: string;
  /** Null means the field was not set in that version — distinct from an empty string. */
  readonly before: string | null;
  readonly after: string | null;
}

/**
 * Keyterms, compared as a set rather than as a list.
 *
 * They are a bias applied to the transcriber and not a sequence — reordering them changes
 * nothing on a call — so reporting "the list changed" would be true and useless. What a
 * reader needs is which words the agent started or stopped listening for, because that is
 * the change that turns a caller's name into a different name.
 */
export interface KeytermChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface ConfigDiff {
  readonly fields: readonly FieldChange[];
  readonly keyterms: KeytermChange;
  /** True when the two versions would produce the same agent. Both lists are then empty. */
  readonly identical: boolean;
}

/** Absent stays absent. `String(null)` is the string "null", which is a lie about the row. */
const render = (value: string | number | null | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * The leaves of one configuration, flattened to the paths the diff reports.
 *
 * Written out rather than derived by walking the object, because a generic walker silently
 * ignores a field nobody taught it about — and a change the diff does not mention reads as
 * a change that did not happen.
 *
 * This used to claim that forgetting a field here was a compile error. It is not: the
 * return type is keyed by `string`, so an omission type-checks perfectly, and `speakingRate`
 * was missing from this list for exactly as long as it took somebody to change a pace and be
 * told nothing had changed. `diff.test.ts` now walks `AgentConfigFields` and fails on any
 * key without a path here, which is the guarantee the comment used to describe.
 */
const leaves = (config: AgentConfigFields): Readonly<Record<string, string | null>> => ({
  name: config.name,
  voiceId: render(config.voiceId),
  speakingRate: render(config.speakingRate),
  greeting: render(config.greeting),
  persona: render(config.persona),
  instructions: render(config.instructions),
  /**
   * One leaf for the whole set, unlike every other structured field here.
   *
   * `businessHours` and `escalation` are flattened because their shape is fixed and a
   * reader wants to know which hour moved. Policies are a list an operator adds to and
   * reorders, so per-leaf paths would report renumbering as a dozen changes and hide the
   * one rule that actually changed. Serialised whole: the history says the policies were
   * edited, and the version snapshot beside it says exactly how.
   */
  policyBlocks: config.policyBlocks == null ? null : JSON.stringify(config.policyBlocks),
  /* No `businessHours` rows. They left the configuration document in migration 0053, and
     they were never in a version before that — `CONFIG_COLUMNS` has never snapshotted them,
     so both sides of every diff read null and the three rows could only ever say "unchanged".
     Hours change through the organisation endpoint, which is not versioned. */
  "escalation.toNumber": render(config.escalation?.toNumber),
  "escalation.fromNumber": render(config.escalation?.fromNumber),
  "escalation.ringSeconds": render(config.escalation?.ringSeconds),
});

/**
 * Terms in `after` that are not in `before`, compared without regard to case.
 *
 * Case-insensitively because the keyterm merge de-duplicates that way: "Ansa" and "ansa"
 * are one term by the time the transcriber sees them, so reporting a capitalisation edit as
 * a term added and a term removed would be reporting a change to the agent's hearing that
 * did not occur.
 */
const missingFrom = (
  present: readonly string[],
  candidates: readonly string[],
): readonly string[] => {
  const known = new Set(present.map((term) => term.trim().toLowerCase()));
  return candidates.filter((term) => !known.has(term.trim().toLowerCase()));
};

export const diffConfigurations = (
  before: AgentConfigFields,
  after: AgentConfigFields,
): ConfigDiff => {
  const left = leaves(before);
  const right = leaves(after);

  const fields: FieldChange[] = [];
  for (const field of Object.keys(left)) {
    const from = left[field] ?? null;
    const to = right[field] ?? null;
    if (from === to) continue;
    fields.push({ field, before: from, after: to });
  }

  const keyterms = {
    added: missingFrom(before.keyterms, after.keyterms),
    removed: missingFrom(after.keyterms, before.keyterms),
  };

  return {
    fields,
    keyterms,
    identical: fields.length === 0 && keyterms.added.length === 0 && keyterms.removed.length === 0,
  };
};

/**
 * What changed between two graphs, in the operator's terms.
 *
 * The field diff above compares the projected question list, and a graph can change without
 * that list moving at all: rewire a branch so the deposit question is asked when the caller
 * says "buy" instead of "rent", and every question is still there in the same order. That is
 * the one change most worth seeing, and "no changes" is exactly the wrong answer to it.
 *
 * Steps are matched by id, connections by their two ends and the port they leave from. A
 * step whose question, text, tool or branch key moved is "changed"; its position on the
 * canvas is not a change to the call and is ignored. A connection whose condition moved is
 * reported as removed and added, because a branch that used to wait for "rent" and now waits
 * for "buy" is a different connection to a caller.
 */
export interface FlowChange {
  /** Which director each version ran. Different is a change of authoring model. */
  readonly shape: { readonly before: "form" | "flow"; readonly after: "form" | "flow" };
  readonly steps: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
  };
  readonly connections: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
  };
  /** True when a call would walk the same graph. */
  readonly identical: boolean;
}

/** A step, named the way the problems panel names it — by what it does, then its id. */
const stepName = (node: FlowNode): string => {
  const what =
    node.kind === "collect" ? (node.field?.key ?? "") :
    node.kind === "say" ? (node.text ?? "").slice(0, 40) :
    node.kind === "tool" ? (node.tool ?? "") :
    node.kind === "decide" || node.kind === "confirm" ? (node.on ?? "") : "";
  return what === "" ? `${node.kind} ${node.id}` : `${node.kind} "${what}"`;
};

/** Everything about a step that a call can hear, and nothing about where it is drawn. */
const stepSubstance = (node: FlowNode): string =>
  JSON.stringify({ kind: node.kind, field: node.field, text: node.text, tool: node.tool, on: node.on });

/** A connection is its ends, its port, and its condition — one string, comparable. */
const connectionKey = (edge: FlowEdge): string =>
  JSON.stringify([edge.from, edge.to, edge.port ?? null, edge.when ?? null, edge.otherwise ?? null]);

const connectionName = (edge: FlowEdge, byId: ReadonlyMap<string, FlowNode>): string => {
  const from = byId.get(edge.from);
  const to = byId.get(edge.to);
  const when =
    edge.when === undefined ? (edge.otherwise === true ? " (anything else)" : "")
    : "equals" in edge.when ? ` (is "${edge.when.equals}")`
    : "oneOf" in edge.when ? ` (is one of ${edge.when.oneOf.map((v) => `"${v}"`).join(", ")})`
    : "isEmpty" in edge.when ? " (not given)"
    : ` (more than ${edge.when.greaterThan})`;
  return `${from === undefined ? edge.from : stepName(from)} → ${to === undefined ? edge.to : stepName(to)}${when}`;
};

export const diffFlows = (
  before: { readonly shape: "form" | "flow"; readonly flow: Flow | null },
  after: { readonly shape: "form" | "flow"; readonly flow: Flow | null },
): FlowChange => {
  const left = new Map((before.flow?.nodes ?? []).map((node) => [node.id, node]));
  const right = new Map((after.flow?.nodes ?? []).map((node) => [node.id, node]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, node] of right) {
    const was = left.get(id);
    if (was === undefined) added.push(stepName(node));
    else if (stepSubstance(was) !== stepSubstance(node)) changed.push(stepName(node));
  }
  for (const [id, node] of left) if (!right.has(id)) removed.push(stepName(node));

  const leftEdges = new Map((before.flow?.edges ?? []).map((edge) => [connectionKey(edge), edge]));
  const rightEdges = new Map((after.flow?.edges ?? []).map((edge) => [connectionKey(edge), edge]));
  const connectionsAdded: string[] = [];
  const connectionsRemoved: string[] = [];
  for (const [key, edge] of rightEdges) if (!leftEdges.has(key)) connectionsAdded.push(connectionName(edge, right));
  for (const [key, edge] of leftEdges) if (!rightEdges.has(key)) connectionsRemoved.push(connectionName(edge, left));

  return {
    shape: { before: before.shape, after: after.shape },
    steps: { added, removed, changed },
    connections: { added: connectionsAdded, removed: connectionsRemoved },
    identical:
      before.shape === after.shape &&
      added.length === 0 && removed.length === 0 && changed.length === 0 &&
      connectionsAdded.length === 0 && connectionsRemoved.length === 0,
  };
};
