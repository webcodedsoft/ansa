/**
 * Whether a conversation graph is allowed to answer a phone.
 *
 * `flow.ts` deliberately holds no validator, because the API validates request shape with its
 * own schema DSL and the console with zod, and a third opinion about *shape* would be a third
 * place to keep a rule. This is not that. Shape validation asks whether the JSON is a graph;
 * this asks whether the graph is a conversation — whether a call walking it can always say
 * something next, always finish, and never branch on an answer it was never given. Neither a
 * schema DSL nor zod can express "collected on every path", so the question has to live
 * somewhere both halves can ask it, and it costs this package no runtime dependency.
 *
 * Every problem is phrased as a consequence to the call rather than to the data structure,
 * because the operator reading it on the canvas is thinking about a phone call and has never
 * heard of a directed graph.
 *
 * The rules compose into a guarantee larger than any one of them: a reachable subgraph that is
 * acyclic and has no dead ends is finite and descending, so every reachable step eventually
 * reaches a `transfer` or a `hangup`. That is the property that actually matters — no call can
 * be left holding — and it is why `cycle` and `dead-end` are both blocking rather than either
 * one being enough on its own.
 */

import {
  MAX_FLOW_FIELDS,
  TERMINAL_KINDS,
  type Flow,
  type FlowEdge,
  type FlowNode,
  type FlowNodeKind,
  type FlowProblem,
} from "./flow";
import { fieldsCollectedBefore } from "./flow-project";

const TERMINAL = new Set<FlowNodeKind>(TERMINAL_KINDS);

const problem = (
  nodeId: string | null,
  code: FlowProblem["code"],
  message: string,
  blocking = true,
): FlowProblem => ({ nodeId, code, message, blocking });

const addTo = <T>(index: Map<string, T[]>, key: string, value: T): void => {
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [value]);
  else bucket.push(value);
};

/** A `collect` node saves exactly one answer. Anything else saves none. */
const savedBy = (node: FlowNode): string | undefined =>
  node.kind === "collect" && node.field !== undefined && node.field.key !== ""
    ? node.field.key
    : undefined;



export const validateFlow = (flow: Flow): readonly FlowProblem[] => {
  const problems: FlowProblem[] = [];

  const byId = new Map<string, FlowNode>();
  for (const node of flow.nodes) byId.set(node.id, node);

  // An edge with a missing endpoint is not a connection, so it is kept out of both indexes
  // rather than papered over. A `decide` whose otherwise-branch points at a deleted step is
  // then reported twice — once for the dangling connection and once for having no catch-all —
  // and both are true: the operator has to fix the branch and re-point it.
  const leaving = new Map<string, FlowEdge[]>();
  for (const edge of flow.edges) {
    const fromExists = byId.has(edge.from);
    const toExists = byId.has(edge.to);
    if (fromExists && toExists) {
      addTo(leaving, edge.from, edge);
      continue;
    }
    if (toExists) {
      problems.push(problem(
        edge.to,
        "edge-to-nowhere",
        "A connection into this step comes from a step that is no longer here, so no call will ever arrive along it.",
      ));
      continue;
    }
    problems.push(problem(
      fromExists ? edge.from : null,
      "edge-to-nowhere",
      "This step leads to a step that is no longer here, so the call would stop talking when it got there.",
    ));
  }

  const starts = flow.nodes.filter((node) => node.kind === "start");
  if (starts.length === 0) {
    problems.push(problem(
      null,
      "no-start",
      "This flow has no starting step, so there is nothing to say when someone calls.",
    ));
  }
  // Every start is named, not just the extras: which one to keep is the operator's decision,
  // and the canvas can only offer it if all the candidates are marked.
  if (starts.length > 1) {
    for (const start of starts) {
      problems.push(problem(
        start.id,
        "many-starts",
        "There is more than one starting step, so nothing decides where the call begins.",
      ));
    }
  }

  const reachable = new Set<string>();
  const frontier = starts.map((start) => start.id);
  for (let id = frontier.pop(); id !== undefined; id = frontier.pop()) {
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of leaving.get(id) ?? []) frontier.push(edge.to);
  }

  // With no start, nothing is reachable and flagging every step as unreachable would bury the
  // one problem the operator can actually act on.
  if (starts.length > 0) {
    for (const node of flow.nodes) {
      if (reachable.has(node.id)) continue;
      problems.push(problem(
        node.id,
        "unreachable",
        "Nothing reaches this step, so it will never run.",
        false,
      ));
    }
  }

  for (const node of flow.nodes) {
    if (!reachable.has(node.id)) continue;
    if (TERMINAL.has(node.kind)) continue;
    if ((leaving.get(node.id) ?? []).length > 0) continue;
    problems.push(problem(
      node.id,
      "dead-end",
      "Nothing leads out of this step, so the call would go quiet here and the caller would be left holding.",
    ));
  }

  // Greyed while on the stack, blackened once finished: an edge into a grey node is an edge
  // back into the path we are standing on, and its target is where the loop closes. That
  // target is the step the operator has to break, so it is the one the problem lands on.
  const onStack = new Set<string>();
  const finished = new Set<string>();
  const loopsBackTo = new Set<string>();
  const walk = (id: string): void => {
    onStack.add(id);
    for (const edge of leaving.get(id) ?? []) {
      if (onStack.has(edge.to)) loopsBackTo.add(edge.to);
      else if (!finished.has(edge.to)) walk(edge.to);
    }
    onStack.delete(id);
    finished.add(id);
  };
  for (const start of starts) if (!finished.has(start.id)) walk(start.id);

  for (const node of flow.nodes) {
    if (!loopsBackTo.has(node.id)) continue;
    problems.push(problem(
      node.id,
      "cycle",
      "The call can come back round to this step, so it could ask the same things over and over and never reach the end.",
    ));
  }

  /* The must-analysis this rule needs — which answers the call is *certain* to hold on arrival
     — lives in `flow-project.ts` as `fieldsCollectedBefore`, and this consumes it rather than
     keeping a second copy.

     It was written twice, independently and correctly, by two people working in parallel. That
     is the more dangerous kind of duplication: both agreed, so nothing failed, and the console's
     "branch on" dropdown and this publish gate would have drifted apart only later, silently,
     each still convinced it knew what the caller had been asked. One implementation, one answer.

     Intersection and not union is the whole rule: an answer collected down one branch of a
     `decide` and not the other must not survive the merge, because branching on a value the call
     might not have is a call that stalls in front of a customer. */

  for (const node of flow.nodes) {
    if (node.kind !== "decide") continue;

    // Unreachable decides are skipped: with no path to them the intersection is over nothing,
    // which would vacuously pass and say something untrue. `unreachable` already covers them.
    if (reachable.has(node.id)) {
      if (node.on === undefined || node.on === "") {
        problems.push(problem(
          node.id,
          "decide-on-missing-field",
          "This step splits the call in two but never says which answer it reads, so there is nothing for it to decide on.",
        ));
      } else if (!fieldsCollectedBefore(flow, node.id).has(node.on)) {
        problems.push(problem(
          node.id,
          "decide-on-missing-field",
          `This step branches on "${node.on}", but the call can reach it without ever having been asked for "${node.on}", so on that route there would be nothing to branch on.`,
        ));
      }
    }

    // Checked on every decide, reachable or not: it is a property of the step itself, and an
    // operator who wires the step up later should not have the problem appear only then.
    const catchAll = (leaving.get(node.id) ?? []).filter((edge) => edge.otherwise === true);
    if (catchAll.length === 0) {
      problems.push(problem(
        node.id,
        "decide-without-otherwise",
        "This step has no branch for anything else the caller might say, so an unexpected answer would leave the call with nowhere to go.",
      ));
    } else if (catchAll.length > 1) {
      problems.push(problem(
        node.id,
        "decide-without-otherwise",
        "More than one branch out of this step claims to catch everything else, so which way the call goes is anybody's guess.",
      ));
    }
  }

  const keysSoFar = new Set<string>();
  let questions = 0;
  for (const node of flow.nodes) {
    if (node.kind !== "collect") continue;
    questions += 1;
    const key = savedBy(node);
    if (key === undefined) {
      problems.push(problem(
        node.id,
        "collect-without-field",
        "This step is meant to ask the caller something, but no question has been written on it, so the call would stop here with nothing to say.",
      ));
      continue;
    }
    // The first use is the one that works, so the problem lands on the later step — that is the
    // one the operator has to rename.
    if (keysSoFar.has(key)) {
      problems.push(problem(
        node.id,
        "duplicate-field-key",
        `An earlier step already saves its answer as "${key}", so this one would write over it and the first answer would be lost.`,
      ));
      continue;
    }
    keysSoFar.add(key);
  }

  // Graph-level, so it lands on no node: no single step is at fault and pinning it on an
  // arbitrary one would send the operator to delete the wrong question.
  if (questions > MAX_FLOW_FIELDS) {
    problems.push(problem(
      null,
      "too-many-fields",
      `This flow asks ${questions} questions and a call can only carry ${MAX_FLOW_FIELDS}, so the answers past that would have nowhere to go.`,
    ));
  }

  return problems;
};
