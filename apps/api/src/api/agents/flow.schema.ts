import {
  AUTHORING_MODES,
  FLOW_LIMITS,
  FLOW_NODE_KINDS,
  FLOW_VERSION,
  type AuthoringMode,
  type Flow,
  type FlowField,
  type FlowNode,
} from "@ansa/shared";

import {
  choice,
  flag,
  integer,
  list,
  number,
  object,
  optional,
  text,
  type FieldError,
  type Infer,
  type Schema,
} from "../http/schema";
import { capturedField } from "../schemas";

/**
 * The conversation graph, said in the schema DSL so one declaration validates it, projects
 * it back out and describes it in `openapi.json`.
 *
 * `@ansa/shared/flow.ts` is the contract; this is the API's half of it. The types there
 * carry no validator on purpose — the console validates with zod, this validates with the
 * DSL, and a third opinion in a package with no runtime dependencies would be a third place
 * to keep the same rule. So the job here is fidelity: every bound comes from `FLOW_LIMITS`
 * or from the shared constant lists, never from a number typed in again.
 *
 * Three of the shared shapes are narrower than the DSL can spell, and each is checked by
 * `flowProblems` instead:
 *
 *   - `FlowCondition` is a union of four one-key objects. The DSL has objects with optional
 *     keys and no unions, so the schema accepts all four keys and the check refuses any
 *     condition that does not carry exactly one.
 *   - `isEmpty` and `otherwise` are the literal `true`. The DSL has `boolean`, so the check
 *     refuses `false` — which would otherwise be a silently inert edge.
 *   - `version` is the literal `FLOW_VERSION`, expressed here as an integer whose minimum
 *     and maximum are both that number. The value is right; only the TypeScript type widens.
 *
 * Nothing here asks whether the graph is a *conversation* — whether every path can say
 * something next and eventually hang up. That is `validateFlow` in `@ansa/shared`, and it
 * runs where a graph is published rather than where its JSON is read.
 */

/**
 * A question, borrowed rather than restated.
 *
 * `capturedField` and `FlowField` are the same thing — a question means what it means
 * whether it was typed into the form or dropped onto a canvas, and the projection from a
 * graph back to `capturedFields` is only trivial because the shapes are identical. Writing
 * a second copy of it against `FLOW_LIMITS` would be the fastest way to make that stop
 * being true.
 *
 * The annotation is the guard: if either side gains a field type, renames a key or changes
 * an enum, this assignment stops compiling. It does not compare the numeric bounds, which
 * is the one drift still possible — `schemas.ts` spells them as literals because it predates
 * the shared contract, and re-expressing them in terms of `FLOW_LIMITS` is a change to a
 * file this one does not own.
 */
const flowField: Schema<FlowField> = capturedField;

/**
 * A node id, and an edge's reference to one.
 *
 * `FLOW_LIMITS` does not bound it, because nothing about a call depends on its length — it
 * is a handle the console mints and the validator follows. Bounded here all the same, at the
 * same 64 characters a field key gets, so an unbounded string cannot arrive at a write
 * endpoint inside a 120-node document.
 */
const nodeId = (): Schema<string> => text({ minLength: 1, maxLength: FLOW_LIMITS.keyLength });

/**
 * A labelled output — "got"/"gave-up", "yes"/"no", "ok"/"failed".
 *
 * Text rather than a `choice`, because the shared contract documents those as the ports that
 * exist today and not as the closed set. A `choice` here would refuse a port added on the
 * console's side of the contract before this file learned about it, which is a 422 on a graph
 * that is perfectly well formed.
 */
/* The one figure, from the shared limits, so this and the console cannot drift. It used to
   be a local 32 while the console bounded the port not at all. */
const PORT_LIMIT = FLOW_LIMITS.portLength;

const flowNode: Schema<FlowNode> = object({
  id: nodeId(),
  /* `choice` reads its literal union off the array it is handed, and `FLOW_NODE_KINDS` is
     already `as const` — so this stays in step with the eight kinds without naming one here. */
  kind: choice(FLOW_NODE_KINDS),
  /** Canvas position. Unbounded on purpose: an operator may pan a graph anywhere, and a
      coordinate no call ever reads is not worth a limit that could refuse a saved layout. */
  x: number(),
  y: number(),
  field: optional(flowField),
  text: optional(text({ maxLength: FLOW_LIMITS.sayLength })),
  tool: optional(text({ maxLength: FLOW_LIMITS.toolNameLength })),
  on: optional(text({ maxLength: FLOW_LIMITS.keyLength })),
  /** The service the console draws this step in. Stored and returned; nothing on a call reads it. */
  service: optional(text({ maxLength: FLOW_LIMITS.options.valueLength })),
});

/**
 * Four operators and no expression language, exactly as the shared contract has it.
 *
 * All four keys optional here and exactly one required by `flowProblems`. The wire shape is
 * therefore identical to `FlowCondition` — `{ "equals": "yes" }` and nothing else — even
 * though the TypeScript the DSL infers is wider than the union.
 */
const flowCondition = object({
  equals: optional(text({ maxLength: FLOW_LIMITS.options.valueLength })),
  oneOf: optional(
    list(text({ maxLength: FLOW_LIMITS.options.valueLength }), {
      maxItems: FLOW_LIMITS.options.max,
    }),
  ),
  /** Only `true` is meaningful. `false` is refused rather than read as "is not empty". */
  isEmpty: optional(flag()),
  greaterThan: optional(number()),
});

const flowEdge = object({
  from: nodeId(),
  to: nodeId(),
  port: optional(text({ maxLength: PORT_LIMIT })),
  when: optional(flowCondition),
  /** Only `true`, for the reason `isEmpty` gives. */
  otherwise: optional(flag()),
});

/**
 * The whole graph.
 *
 * `version` is pinned by making the minimum and the maximum both `FLOW_VERSION`, so a
 * document written against a future revision is refused at the edge rather than walked by
 * code that predates it.
 */
export const flow = object({
  version: integer({ minimum: FLOW_VERSION, maximum: FLOW_VERSION }),
  nodes: list(flowNode, { maxItems: FLOW_LIMITS.nodes }),
  edges: list(flowEdge, { maxItems: FLOW_LIMITS.edges }),
});

export type FlowBody = Infer<typeof flow>;

/** Which editor authored this agent, and therefore which director runs its calls. */
export const authoringMode = (): Schema<AuthoringMode> => choice(AUTHORING_MODES);

const CONDITION_OPERATORS = ["equals", "oneOf", "isEmpty", "greaterThan"] as const;

/**
 * The narrowings the DSL cannot carry, checked once over a document it has already validated.
 *
 * Returned rather than thrown so the caller decides the status, and returned as `FieldError`s
 * so they land beside the schema's own in a 422 — an operator whose canvas produced a bad
 * edge should not have to tell which of two validators complained.
 */
export const flowProblems = (body: FlowBody): readonly FieldError[] => {
  const errors: FieldError[] = [];

  body.edges.forEach((edge, index) => {
    const at = `flow.edges.${index}`;

    if (edge.otherwise === false) {
      errors.push({
        path: `${at}.otherwise`,
        message: "must be true or left out — an edge is the fallback or it is not",
      });
    }

    if (edge.when === undefined) return;

    const when = edge.when;
    const set = CONDITION_OPERATORS.filter((key) => when[key] !== undefined);
    if (set.length !== 1) {
      errors.push({
        path: `${at}.when`,
        message: `must carry exactly one of: ${CONDITION_OPERATORS.join(", ")}`,
      });
    }
    if (when.isEmpty === false) {
      errors.push({
        path: `${at}.when.isEmpty`,
        message: "must be true or left out — there is no 'is not empty' operator",
      });
    }
  });

  return errors;
};

/**
 * The validated body as the shared type.
 *
 * A cast, and it is honest by the time it runs: the schema has pinned `version` to
 * `FLOW_VERSION` and `flowProblems` has refused every condition that is not one of the four
 * the union names. What is left is a difference of spelling between a union the DSL cannot
 * write and an object with four optional keys, not a difference of value.
 */
export const asFlow = (body: FlowBody): Flow => body as unknown as Flow;
