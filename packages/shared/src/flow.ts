/**
 * The conversation graph, as a shape both halves of the product agree on.
 *
 * An agent can be authored two ways: the form, which is an ordered list of questions, or a
 * flow, which is a graph that branches. This module is the contract between them — the API
 * validates and walks it, the console draws and edits it, and neither owns it.
 *
 * It lives in `@ansa/shared` and imports nothing at all, on purpose. A graph type that pulled
 * in `node:` anything would be unusable in the browser, and a second copy of it in the console
 * is how the two halves start disagreeing about what a node is.
 *
 * Types and constants only — no validator. The API validates with its own schema DSL, the way
 * every other endpoint does, and the console with zod. Putting a third opinion here would mean
 * a runtime dependency in a package that has none and two places to keep a rule.
 *
 * `capturedFieldSchema` is deliberately mirrored rather than re-invented: a question means the
 * same thing whether it was typed into the form or dropped onto a canvas, and the projection
 * back to `capturedFields` is only trivial because the shapes are identical.
 */

export const FLOW_VERSION = 1;

/** The 14 kinds a question can be. Mirrors `capturedFieldSchema` in the console. */
export const FLOW_FIELD_TYPES = [
  "name", "reference", "phone", "email", "address", "date", "time",
  "amount", "nin", "bvn", "otp", "quantity", "choice", "text",
] as const;

/** The bounds both validators enforce. Written once so they cannot drift apart. */
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

export interface FlowField {
  readonly key: string;
  readonly type: (typeof FLOW_FIELD_TYPES)[number];
  readonly prompt: string;
  readonly capture: "speech" | "keypad" | "either";
  readonly confirm: "none" | "readback" | "spellback";
  readonly pattern: string;
  readonly attempts: number;
  readonly required: boolean;
  readonly options: readonly string[];
}

export const FLOW_NODE_KINDS = [
  "start", "say", "collect", "confirm", "decide", "tool", "transfer", "hangup",
] as const;

export type FlowNodeKind = (typeof FLOW_NODE_KINDS)[number];

/** Which node kinds end a call. A reachable node must be able to reach one of these. */
export const TERMINAL_KINDS: readonly FlowNodeKind[] = ["transfer", "hangup"];

export interface FlowNode {
  readonly id: string;
  readonly kind: FlowNodeKind;
  /** Canvas position. Carried so a reopened flow looks the way it was left. */
  readonly x: number;
  readonly y: number;
  /** `collect` only — the question this step asks. */
  readonly field?: FlowField;
  /** `say` only — an instruction at this point in the call, not a script to read out. */
  readonly text?: string;
  /** `tool` only — the name of an already-enabled tool. Placing a node does not enable one. */
  readonly tool?: string;
  /** `decide` and `confirm` only — the field key this step reads. */
  readonly on?: string;
}

/**
 * Deliberately four operators and no expression language.
 *
 * An operator writing predicates into a text box is a support burden and a security surface,
 * and every case that needs more than this belongs in a tool.
 */
export type FlowCondition =
  | { readonly equals: string }
  | { readonly oneOf: readonly string[] }
  | { readonly isEmpty: true }
  | { readonly greaterThan: number };

export interface FlowEdge {
  readonly from: string;
  readonly to: string;
  /** Which labelled output it leaves by — "got"/"gave-up", "yes"/"no", "ok"/"failed". */
  readonly port?: string;
  /** `decide` only. */
  readonly when?: FlowCondition;
  /** `decide` only, and exactly one per decide node: callers say unlisted things. */
  readonly otherwise?: true;
}

export interface Flow {
  readonly version: typeof FLOW_VERSION;
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
}

/** An agent is authored one way or the other, and it decides which editor and which director. */
export const AUTHORING_MODES = ["form", "flow"] as const;
export type AuthoringMode = (typeof AUTHORING_MODES)[number];

/**
 * Something wrong with a graph, said in terms of the call rather than the data structure.
 *
 * `nodeId` is what lets the canvas put the message on the step it belongs to. A problem with
 * nowhere to land is the bug the console's `FIELD_TAB` mapping exists to prevent, one level up.
 */
export interface FlowProblem {
  readonly nodeId: string | null;
  /** Stable identifier for tests and for the console to key messages off. */
  readonly code:
    | "no-start" | "many-starts" | "dead-end" | "cycle" | "unreachable"
    | "decide-on-missing-field" | "decide-without-otherwise"
    | "duplicate-field-key" | "too-many-fields" | "collect-without-field"
    | "edge-to-nowhere";
  readonly message: string;
  /** Blocking problems refuse a publish. Non-blocking ones are shown and allowed. */
  readonly blocking: boolean;
}

/** The API's own cap on a form, and therefore on a graph's projection. */
export const MAX_FLOW_FIELDS = 40;

/** An empty flow that is valid, publishable and useless — what a new canvas starts as. */
export const emptyFlow = (): Flow => ({
  version: FLOW_VERSION,
  nodes: [
    { id: "start", kind: "start", x: 40, y: 120 },
    { id: "end", kind: "hangup", x: 380, y: 120 },
  ],
  edges: [{ from: "start", to: "end" }],
});

