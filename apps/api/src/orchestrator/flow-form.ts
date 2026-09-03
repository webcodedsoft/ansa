import type { Flow, FlowCondition, FlowEdge, FlowNode } from "@ansa/shared";
import { FLOW_LIMITS, TERMINAL_KINDS } from "@ansa/shared";

import type { CollectedField } from "../tenancy/captured-fields";

import type { CapturedValue, FormDirector, FormField } from "./form";
import { createForm } from "./form";

/**
 * The second conversation director: the one that walks a graph.
 *
 * `form.ts` decides what to ask next with a single `Array.find` over an ordered list. That
 * one line is the linear assumption sitting underneath every Ansa call — an agent can only
 * ever ask its questions in the order they were typed, and can never ask a different second
 * question because of the first answer.
 *
 * Branching is not a change to that assumption, it is a second director behind the same
 * interface. The orchestrator calls `form.outstanding()` from `armNextField()` and has never
 * known how the decision was made; a graph-walking `FormDirector` is therefore invisible
 * above this file. Nothing in `orchestrator.ts` needs to learn what a node is.
 *
 * ## Position is derived, not remembered
 *
 * The obvious implementation holds a mutable `currentNode` and advances it on `satisfy`.
 * This one does not. Position is recomputed by replaying the collected values from `start`
 * on every question, and that buys three things the pointer cannot:
 *
 * - **A reconnecting call is safe.** A media socket that drops and comes back rebuilds the
 *   director from the values it already has and lands in exactly the same place. There is no
 *   second code path for resumption, because resumption is the only code path.
 * - **A correction re-routes for free.** When a caller corrects the value a `decide` branched
 *   on, the next walk evaluates that decide against the new value and comes out on the other
 *   branch. A pointer would have to be unwound, and unwinding is where this kind of code goes
 *   wrong.
 * - **Values on an abandoned branch are kept without being required.** They stay in `values`
 *   because the caller said them; they stop holding the call open because they are no longer
 *   on the path the walk takes.
 *
 * The cost is a graph traversal per question instead of an array lookup. A flow is capped at
 * 120 nodes and a call asks a handful of questions, so this is not a latency decision.
 *
 * ## It never throws, and silence is the failure it refuses
 *
 * CLAUDE.md: any failure degrades into speech, never silence. A graph that is missing its
 * start, dead-ends, or reaches a `decide` that matches nothing and has no `otherwise` is a
 * graph this director cannot walk. In every one of those cases `outstanding()` returns null
 * and `complete()` returns true, so the call carries on as an ordinary LLM conversation
 * rather than waiting on a question that will never be chosen. Every interface method is
 * wrapped so that a bug here costs the form, never the line.
 */

/**
 * The most nodes one walk may visit before it is treated as a cycle.
 *
 * Validation reports `cycle` as a problem, but a director must not depend on having been
 * validated — a flow written by an older console, or a row edited by hand in psql, reaches
 * this code having been checked by nobody. Without a ceiling a loop of `say` nodes spins the
 * event loop of a process that is carrying other people's calls. Derived from the published
 * limits so it cannot drift below what a legitimate graph needs: a walk that never repeats a
 * node cannot exceed the node count, let alone the node count plus the edge count.
 */
const MAX_STEPS = FLOW_LIMITS.nodes + FLOW_LIMITS.edges;

/**
 * The flow's own field shape, projected onto the one the list director already parses.
 *
 * Identical member for member except `options`, which only a `choice` uses and which nothing
 * below the capture engine reads. `flow.ts` says the mirroring is deliberate; this is the
 * function that collects on it.
 */
const toCollected = (field: NonNullable<FlowNode["field"]>): CollectedField => ({
  key: field.key,
  type: field.type,
  prompt: field.prompt,
  capture: field.capture,
  confirm: field.confirm,
  required: field.required,
  pattern: field.pattern,
  attempts: field.attempts,
});

/**
 * One node's question, built by the list director rather than beside it.
 *
 * `createForm` owns pattern anchoring, the 256-character matching ceiling, the invalid-regex
 * fallback and the set of kinds the engine cannot capture. Reimplementing any of that here
 * would put two copies of a security-relevant decision in the repo and they would drift.
 * Calling it with a single field costs one small object per `collect` node, once, at call
 * setup — and it returns null for exactly the kinds the list director also refuses to ask
 * for, which is `choice` and free `text`.
 */
const questionFor = (field: NonNullable<FlowNode["field"]>): FormField | null =>
  createForm([toCollected(field)]).outstanding();

/** Spoken answers are not typed answers. Case and stray spacing are not a different branch. */
const same = (heard: string, configured: string): boolean =>
  heard.trim().toLowerCase() === configured.trim().toLowerCase();

/**
 * A spoken amount as a number, or NaN.
 *
 * Values arrive canonicalised by the normalizer, but an operator comparing against a
 * threshold means the quantity, not the punctuation, so grouping commas, spaces and a naira
 * sign are stripped before parsing. A value that is not a number does not satisfy
 * `greaterThan`; it falls to `otherwise`, which is the branch a caller who said something
 * unexpected is meant to get.
 */
const asNumber = (value: string): number => {
  const digits = value.replace(/[^\d.-]/g, "");
  return digits === "" ? Number.NaN : Number(digits);
};

/** Evaluate one edge condition against the value the `decide` node reads. */
const holds = (condition: FlowCondition, value: string | undefined): boolean => {
  if ("isEmpty" in condition) return value === undefined || value.trim() === "";
  if (value === undefined) return false;
  if ("equals" in condition) return same(value, condition.equals);
  if ("oneOf" in condition) return condition.oneOf.some((option) => same(value, option));
  const amount = asNumber(value);
  return Number.isFinite(amount) && amount > condition.greaterThan;
};

/**
 * A jsonb document is whatever is in the row.
 *
 * The parameter is typed `Flow` because callers have validated one, but this director is the
 * last thing between a hand-edited graph and a live call. Reading a non-array as an empty one
 * turns a corrupt document into an agent with no form, which is a working call.
 */
const listOf = <T>(raw: unknown): readonly T[] => (Array.isArray(raw) ? (raw as T[]) : []);

/** Where a walk stopped, which is the whole of what the interface needs to answer. */
type Stop =
  | { readonly kind: "collect"; readonly node: FlowNode; readonly field: FormField }
  /** `transfer` or `hangup` — the call has somewhere to be and nothing left to collect. */
  | { readonly kind: "terminal" }
  /** No start, a dead end, an edge to nowhere, an unresolvable decide, or a cycle. */
  | { readonly kind: "stuck" };

/**
 * Build a director that walks `flow`.
 *
 * A graph this cannot walk produces the same inert director an agent with no form gets:
 * nothing outstanding, nothing wanted, already complete. That is the degradation, and it is
 * the same one `createForm([])` gives.
 */
export const createFlowForm = (flow: Flow): FormDirector => {
  const nodes = new Map<string, FlowNode>();
  const outgoing = new Map<string, FlowEdge[]>();
  /** One question per `collect` node id. Absent for `choice`, free `text` and bad nodes. */
  const questions = new Map<string, FormField>();
  /** Node order, for the deterministic tie-breaks two nodes sharing a field key need. */
  const order: FlowNode[] = [];

  let start: FlowNode | null = null;
  /* Two starts is a blocking validation problem and there is no defensible guess between
     them. Picking the first would make which branch a caller gets depend on array order in
     a jsonb column, so the director refuses to walk instead. */
  let ambiguousStart = false;

  for (const node of listOf<FlowNode>(flow.nodes)) {
    if (typeof node?.id !== "string" || nodes.has(node.id)) continue;
    nodes.set(node.id, node);
    order.push(node);
    if (node.kind === "start") {
      if (start !== null) ambiguousStart = true;
      start = node;
    }
    if (node.kind === "collect" && node.field !== undefined) {
      const question = questionFor(node.field);
      if (question !== null) questions.set(node.id, question);
    }
  }

  for (const edge of listOf<FlowEdge>(flow.edges)) {
    if (typeof edge?.from !== "string" || typeof edge.to !== "string") continue;
    const existing = outgoing.get(edge.from);
    if (existing === undefined) outgoing.set(edge.from, [edge]);
    else existing.push(edge);
  }

  const entry: FlowNode | null = ambiguousStart ? null : start;

  const values = new Map<string, CapturedValue>();
  const skipped = new Set<string>();
  const rejections = new Map<string, number>();
  let askingKey: string | null = null;

  /* Settled by key rather than by node: two `collect` nodes may legitimately carry the same
     field key on branches that never both run, and a value given once has been given. */
  const settled = (key: string): boolean => values.has(key) || skipped.has(key);

  const questionKeyed = (key: string): FormField | null => {
    for (const node of order) {
      const question = questions.get(node.id);
      if (question !== undefined && question.key === key) return question;
    }
    return null;
  };

  /**
   * Which labelled output a node leaves by, given what the caller has said so far.
   *
   * Null means no preference, and then the first edge wins. A port that was configured but
   * has no edge also falls back to the first edge: a missing "gave-up" branch must not strand
   * a call whose caller declined an optional question.
   */
  const preferredPort = (node: FlowNode): string | null => {
    if (node.kind === "collect") {
      const key = questions.get(node.id)?.key;
      if (key !== undefined && skipped.has(key)) return "gave-up";
      return "got";
    }
    /* A `confirm` node asks the caller to agree to a value, and the only record of that
       agreement the director holds is the `confirmed` flag written by the readback. A field
       configured `confirm: "none"` is stored unconfirmed on purpose, so a confirm node
       reading one takes its "no" branch — which is right: nothing confirmed it. With no
       value at all there is nothing to have agreed to, so the node falls through. */
    if (node.kind === "confirm") {
      const held = node.on === undefined ? undefined : values.get(node.on);
      if (held === undefined) return null;
      return held.confirmed ? "yes" : "no";
    }
    return null;
  };

  const decideEdge = (node: FlowNode, out: readonly FlowEdge[]): FlowEdge | undefined => {
    const held = node.on === undefined ? undefined : values.get(node.on)?.value;
    const matched = out.find((edge) => edge.when !== undefined && holds(edge.when, held));
    /* No condition matched and no fallback: `decide-without-otherwise` is a blocking
       validation problem, and a director that guessed here would put a caller down a branch
       nobody configured. Undefined stops the walk, and a stopped walk becomes speech. */
    return matched ?? out.find((edge) => edge.otherwise === true);
  };

  const leave = (node: FlowNode): FlowNode | null => {
    const out = outgoing.get(node.id) ?? [];
    if (out.length === 0) return null;
    if (node.kind === "decide") {
      const chosen = decideEdge(node, out);
      return chosen === undefined ? null : (nodes.get(chosen.to) ?? null);
    }
    const want = preferredPort(node);
    const ported = want === null ? undefined : out.find((edge) => edge.port === want);
    const chosen = ported ?? out[0];
    return chosen === undefined ? null : (nodes.get(chosen.to) ?? null);
  };

  /**
   * Replay from `start` and stop at the first thing the call has to do.
   *
   * `say` and `tool` nodes are passed straight through: they are instructions to the model
   * and to the dispatch path, and neither is a value this director collects. A `collect` node
   * whose value is already in hand — volunteered earlier, or given before a reconnect — is
   * passed through the same way, which is what makes a branch entered late feel like it was
   * always going to be entered.
   */
  const walk = (): Stop => {
    let node = entry;
    for (let steps = 0; steps < MAX_STEPS; steps += 1) {
      if (node === null) return { kind: "stuck" };
      if (TERMINAL_KINDS.includes(node.kind)) return { kind: "terminal" };
      if (node.kind === "collect") {
        const question = questions.get(node.id);
        if (question !== undefined && !settled(question.key)) {
          return { kind: "collect", node, field: question };
        }
      }
      node = leave(node);
    }
    return { kind: "stuck" };
  };

  /**
   * The unsettled questions on the path ahead, starting at the one being asked now.
   *
   * A projection rather than a fact: it assumes each question ahead gets answered, because
   * that is the only way to see past one. Where a `decide` reads a value nobody has given
   * yet it follows `otherwise`, which is the branch a caller who says something unlisted
   * gets — the conservative guess, since it is the one that cannot be configured away.
   *
   * This is what makes "required" mean required *on this path*. A required question on the
   * branch the caller did not take is not a reason to hold the call open.
   */
  const ahead = (from: FlowNode): readonly FormField[] => {
    const found: FormField[] = [];
    let node: FlowNode | null = from;
    for (let steps = 0; steps < MAX_STEPS; steps += 1) {
      if (node === null) break;
      if (TERMINAL_KINDS.includes(node.kind)) break;
      if (node.kind === "collect") {
        const question = questions.get(node.id);
        if (question !== undefined && !settled(question.key)) found.push(question);
      }
      node = leave(node);
    }
    return found;
  };

  /**
   * Every node the graph can get to at all, ignoring conditions.
   *
   * Only used for volunteered values, and deliberately blind to which branch is live: a
   * caller who gives their date of birth before the agent has worked out whether it will ask
   * for it has still given their date of birth. Storing it means that if the branch is later
   * entered, the question is already answered and never gets put.
   */
  const reachable = (): readonly FlowNode[] => {
    const seen = new Set<string>();
    const found: FlowNode[] = [];
    const queue: string[] = entry === null ? [] : [entry.id];
    while (queue.length > 0 && found.length < FLOW_LIMITS.nodes) {
      const id = queue.shift();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      const node = nodes.get(id);
      if (node === undefined) continue;
      found.push(node);
      for (const edge of outgoing.get(id) ?? []) queue.push(edge.to);
    }
    return found;
  };

  /** Never let a defect in the walk become dead air. The fallback is always "no form". */
  const safely = <T>(fallback: T, run: () => T): T => {
    try {
      return run();
    } catch {
      return fallback;
    }
  };

  return {
    outstanding: () =>
      safely(null, () => {
        const stop = walk();
        return stop.kind === "collect" ? stop.field : null;
      }),

    asking: () =>
      safely(null, () => (askingKey === null ? null : questionKeyed(askingKey))),

    beginAsking: (field) => {
      askingKey = field.key;
    },

    forVolunteered: (kind) =>
      safely(null, () => {
        const stop = walk();
        if (stop.kind === "collect") {
          const onPath = ahead(stop.node).find((question) => question.entity === kind);
          if (onPath !== undefined) return onPath;
        }
        /* Nothing of that kind is coming up on this path, so look anywhere the graph can
           reach. Nearest-first breaks the tie — the ambiguity is real and unresolvable from
           a value, exactly as it is for the list director, and the question fewest steps
           from the caller is the one they are most plausibly answering. */
        for (const node of reachable()) {
          const question = questions.get(node.id);
          if (question === undefined) continue;
          if (question.entity === kind && !settled(question.key)) return question;
        }
        return null;
      }),

    satisfy: (key, value, confirmed) => {
      /* Stored whether or not a node wants it. A caller who answers a question the graph was
         never going to ask has still answered it, and the alternative is throwing away a
         value that a tool three nodes later needs. */
      values.set(key, { value, confirmed });
      if (askingKey === key) askingKey = null;
      skipped.delete(key);
    },

    attemptsFor: (key) => (rejections.get(key) ?? 0) + 1,

    reject: (key) =>
      safely({ again: false }, () => {
        const question = questionKeyed(key);
        const count = (rejections.get(key) ?? 0) + 1;
        rejections.set(key, count);
        return { again: count < (question?.attempts ?? 0) };
      }),

    skip: (key) => {
      skipped.add(key);
      if (askingKey === key) askingKey = null;
    },

    /**
     * The walk reached the end, or nothing required is left on the path it is on.
     *
     * A graph this director cannot walk counts as complete. It has to: `outstanding()` has
     * already returned null for that graph, so anything else would hold the call open on a
     * question that can never be asked — which is the silence this file exists to prevent.
     * The invariant to hold onto is that `outstanding() === null` implies `complete()`.
     */
    complete: () =>
      safely(true, () => {
        const stop = walk();
        if (stop.kind !== "collect") return true;
        return !ahead(stop.node).some((question) => question.required);
      }),

    values,
  };
};
