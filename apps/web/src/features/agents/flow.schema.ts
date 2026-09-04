import { z } from "zod";

import { MAX_CAPTURED_FIELDS } from "./agents.schema";

/**
 * The conversation graph, as the console reads and writes it.
 *
 * A mirror of `packages/shared/src/flow.ts` in zod, and deliberately a mirror rather than an
 * import: that module is types and constants with no runtime dependency at all — which is
 * what makes it safe for both halves of the product — and it says why the validator is not
 * in it. The API validates with its own schema DSL the way every other endpoint does, the
 * console with zod, and a third opinion in a package with no dependencies would be one rule
 * kept in three places. This is the same rule as `capturedFieldSchema` in `agents.schema.ts`,
 * which mirrors the API's field schema for exactly the same reason.
 *
 * The obligation a mirror carries is that it mirrors and does not extend. A graph this file
 * accepts and the API rejects is a save that fails after the drawing is finished, with the
 * message arriving from somewhere the operator was not looking. `flow.schema.test.ts` reads
 * the shared file and fails when the two drift, because "keep them in step" is not a rule a
 * comment can hold.
 *
 * One asymmetry worth knowing before it looks like a bug. The generated client types a
 * condition as `{ equals?, oneOf?, isEmpty?, greaterThan? }` and `otherwise` as `boolean`,
 * because the API's schema DSL cannot express a union of four alternatives or a literal. The
 * shared contract can and does, and this follows the contract: sending `{ equals, oneOf }`
 * together would be sending a condition whose second half the walker silently ignores.
 *
 * What is deliberately **not** mirrored is `FlowProblem` and the reachability rules behind
 * it — no path to a terminal, a cycle, a `decide` on a field that is not collected on every
 * path reaching it. Those are decided by walking the graph, the API owns the walk, and a
 * second walk here would be a second opinion about whether an agent is publishable.
 */

export const FLOW_VERSION = 1;

/** The 14 kinds a question can be. The same list as `capturedFieldSchema`, by construction. */
export const FLOW_FIELD_TYPES = [
  "name", "reference", "phone", "email", "address", "date", "time",
  "amount", "nin", "bvn", "otp", "quantity", "choice", "text",
] as const;

/** The bounds both validators enforce. Copied from the shared module, which owns them. */
export const FLOW_LIMITS = {
  keyLength: 64,
  promptLength: 300,
  patternLength: 200,
  attempts: { min: 1, max: 10 },
  options: { max: 24, valueLength: 120 },
  sayLength: 600,
  toolNameLength: 128,
  nodes: 120,
  edges: 240,
} as const;

export const FLOW_NODE_KINDS = [
  "start", "say", "collect", "confirm", "decide", "tool", "transfer", "hangup",
] as const;

export type FlowNodeKind = (typeof FLOW_NODE_KINDS)[number];

/**
 * A field key is a variable name, and the reason is the projection.
 *
 * Every `collect` node writes its field into `capturedFields` on publish, where seventeen
 * source files already read it under this rule. A key the graph allowed and the list did not
 * would be a question that saves, publishes, and then fails validation one layer down.
 */
const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export const flowFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, "A question needs a field name to store its answer under.")
    .max(FLOW_LIMITS.keyLength)
    .regex(FIELD_KEY, "Use letters, digits and underscores, starting with a letter."),
  type: z.enum(FLOW_FIELD_TYPES),
  prompt: z.string().max(FLOW_LIMITS.promptLength),
  capture: z.enum(["speech", "keypad", "either"]),
  confirm: z.enum(["none", "readback", "spellback"]),
  pattern: z.string().max(FLOW_LIMITS.patternLength),
  attempts: z.number().int().min(FLOW_LIMITS.attempts.min).max(FLOW_LIMITS.attempts.max),
  required: z.boolean(),
  options: z.array(z.string().max(FLOW_LIMITS.options.valueLength)).max(FLOW_LIMITS.options.max),
});

export type FlowField = z.infer<typeof flowFieldSchema>;

/**
 * Four operators and no expression language, and `strictObject` is what holds that.
 *
 * A plain object schema strips what it does not know, so `{ equals: "a", oneOf: [] }` would
 * quietly parse as `equals` and the second operator would vanish between the drawing and the
 * call. Strict refuses it instead, which is the honest answer: the four are alternatives.
 *
 * The values carry no length bound because the shared contract names none. Inventing one here
 * would refuse a graph the API accepts, which is drift in the direction nobody tests: the
 * operator is told their own drawing is wrong by the half that does not decide.
 */
export const flowConditionSchema = z.union([
  z.strictObject({ equals: z.string() }),
  z.strictObject({ oneOf: z.array(z.string()) }),
  z.strictObject({ isEmpty: z.literal(true) }),
  z.strictObject({ greaterThan: z.number() }),
]);

export type FlowCondition = z.infer<typeof flowConditionSchema>;

export const flowNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(FLOW_NODE_KINDS),
  /* Canvas position, carried so a reopened flow looks the way it was left. Not sanity-checked
     against a viewport: there isn't one, panning is unbounded, and a node at x = -4000 is
     somebody's layout rather than corrupt data. */
  x: z.number(),
  y: z.number(),
  /** `collect` only. */
  field: flowFieldSchema.optional(),
  /** `say` only — an instruction at this point in the call, not a script to read out. */
  text: z.string().max(FLOW_LIMITS.sayLength).optional(),
  /** `tool` only — the name of an already-enabled tool. Placing a node does not enable one. */
  tool: z.string().max(FLOW_LIMITS.toolNameLength).optional(),
  /** `decide` and `confirm` only — the field key this step reads. */
  on: z.string().max(FLOW_LIMITS.keyLength).optional(),
});

export type FlowNode = z.infer<typeof flowNodeSchema>;

export const flowEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  /** Which labelled output it leaves by — "got"/"gave-up", "yes"/"no", "ok"/"failed". */
  port: z.string().min(1).optional(),
  /** `decide` only. */
  when: flowConditionSchema.optional(),
  /** `decide` only, and exactly one per decide node: callers say unlisted things. */
  otherwise: z.literal(true).optional(),
});

export type FlowEdge = z.infer<typeof flowEdgeSchema>;

export const flowSchema = z.object({
  version: z.literal(FLOW_VERSION),
  nodes: z.array(flowNodeSchema).max(FLOW_LIMITS.nodes, `A flow cannot have more than ${FLOW_LIMITS.nodes} steps.`),
  edges: z.array(flowEdgeSchema).max(FLOW_LIMITS.edges, `A flow cannot have more than ${FLOW_LIMITS.edges} links.`),
});

export type Flow = z.infer<typeof flowSchema>;

/** An empty flow that is valid, publishable and useless — what a new canvas starts as. */
export const emptyFlow = (): Flow => ({
  version: FLOW_VERSION,
  nodes: [
    { id: "start", kind: "start", x: 40, y: 90 },
    { id: "end", kind: "hangup", x: 40, y: 260 },
  ],
  edges: [{ from: "start", to: "end" }],
});

/**
 * A graph off the wire, which arrives as `jsonb` and is therefore untrusted.
 *
 * Three answers, and the third is the one that matters. Absent is a flow nobody has drawn
 * yet, so it is `emptyFlow()` — the canvas opens on Answered wired to End the call rather
 * than on nothing, and the first thing anybody sees is valid. Readable is itself, stripped
 * of anything the contract does not name, so what the canvas sends back is the contract.
 *
 * Unreadable is `null`, and not `emptyFlow()`. A graph this console cannot draw is still a
 * graph somebody drew: substituting an empty one would put two nodes on screen, submit them
 * into the draft on the next save, and overwrite the real thing with the failure to read it.
 * Null makes the canvas say so and write nothing, which is the same rule the policy editor
 * follows when a document will not parse.
 */
export const readFlow = (value: unknown): Flow | null => {
  if (value === null || value === undefined) return emptyFlow();
  const parsed = flowSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/**
 * A form, redrawn as the straight line it already was.
 *
 * The two authoring modes are not two products. A form *is* a graph — one collect per
 * question, wired in the order the caller hears them — and saying so in code is what makes
 * "start from a template, then branch it" a real offer instead of a blank canvas sitting
 * next to a list of questions somebody now has to retype.
 *
 * It is also what keeps the create screen's promise honest. An agent set to run as a graph
 * and holding none cannot be published — the API refuses it, correctly, because it would
 * answer the phone with nothing to say — so something has to draw the first version, and
 * the questions the operator already chose are the only thing worth drawing.
 *
 * Ids are positional (`ask-1`, `ask-2`) and not taken from the field key. A key is the
 * operator's word and can be renamed on the canvas afterwards; a node id that travelled
 * with it would leave every edge pointing at a node that no longer exists.
 *
 * One column, top to bottom. `Tidy up` re-lays it the moment anybody branches — this only
 * has to be legible and not overlapping.
 */
export const flowFromFields = (fields: readonly FlowField[]): Flow => {
  // The API caps a form at forty questions and therefore caps a graph's projection at forty.
  // A template cannot exceed it today; drawing a graph that could never be published because
  // a template grew is not a failure worth leaving available.
  const asked = fields.slice(0, MAX_CAPTURED_FIELDS);
  /* A template that asks nothing is a new canvas, so it is literally one — same two nodes in
     the same places. Two near-identical starting graphs would be one more thing that can
     drift apart, and the difference between them would be four pixels nobody chose. */
  if (asked.length === 0) return emptyFlow();
  // Top to bottom, one step under the last: the way the call reads, and the way the canvas
  // lays a flow out. Tidy up re-lays it the moment anybody branches.
  const nodes: Flow["nodes"][number][] = [{ id: "start", kind: "start", x: 40, y: 90 }];
  const edges: Flow["edges"][number][] = [];

  let previous = "start";
  asked.forEach((field, index) => {
    const id = `ask-${index + 1}`;
    nodes.push({ id, kind: "collect", x: 40, y: 90 + (index + 1) * 170, field });
    edges.push({ from: previous, to: id });
    previous = id;
  });

  nodes.push({ id: "end", kind: "hangup", x: 40, y: 90 + (asked.length + 1) * 170 });
  edges.push({ from: previous, to: "end" });
  return { version: FLOW_VERSION, nodes, edges };
};
