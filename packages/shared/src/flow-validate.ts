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
  type FlowCondition,
  type FlowEdge,
  type FlowNode,
  type FlowNodeKind,
  type FlowProblem,
} from "./flow";
import { canBothRun, fieldsCollectedBeforeEach, reachableNodes } from "./flow-project";

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

/** A condition, in the words the problems panel uses. */
const describe = (condition: FlowCondition): string =>
  "equals" in condition ? `is "${condition.equals}"`
  : "oneOf" in condition ? `is one of ${condition.oneOf.map((value) => `"${value}"`).join(", ")}`
  : "isEmpty" in condition ? "was not given"
  : `is more than ${condition.greaterThan}`;

const lower = (value: string): string => value.trim().toLowerCase();

/**
 * Whether every value the later condition matches, the earlier one matches first.
 *
 * Conservative: only the containments that are certain. Two `greaterThan`s shadow when the
 * earlier threshold is lower, because anything over the higher is over the lower. Two lists
 * shadow when the later is a subset. Nothing is said about a list against a threshold, because
 * a choice and an amount are not the same kind of answer and a decide reads one key.
 */
const shadows = (earlier: FlowCondition, later: FlowCondition): boolean => {
  if ("isEmpty" in earlier) return "isEmpty" in later;
  if ("greaterThan" in earlier) return "greaterThan" in later && later.greaterThan >= earlier.greaterThan;
  const catches = new Set(("equals" in earlier ? [earlier.equals] : earlier.oneOf).map(lower));
  if ("equals" in later) return catches.has(lower(later.equals));
  if ("oneOf" in later) return later.oneOf.length > 0 && later.oneOf.every((value) => catches.has(lower(value)));
  return false;
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
      fromExists
        ? "This step leads to a step that is no longer here, so the call would stop talking when it got there."
        : "A connection joins two steps that are both gone. It does nothing and can be removed.",
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
      "The call can come back round to this step. A flow does not loop: to ask again after a wrong answer, the agent already re-asks on its own, so this connection is not needed.",
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

  const collectedBefore = fieldsCollectedBeforeEach(flow);
  /* What kind of answer each key holds, so a branch can be checked against the question it
     reads. First reachable collect wins, matching the projection. */
  const questionByKey = new Map<string, NonNullable<FlowNode["field"]>>();
  for (const node of reachableNodes(flow)) {
    const key = savedBy(node);
    if (key !== undefined && node.field !== undefined && !questionByKey.has(key)) {
      questionByKey.set(key, node.field);
    }
  }

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
      } else if (!(collectedBefore.get(node.id) ?? new Set()).has(node.on)) {
        problems.push(problem(
          node.id,
          "decide-on-missing-field",
          `This step branches on "${node.on}", but the call can reach it without ever having been asked for "${node.on}", so on that route there would be nothing to branch on.`,
        ));
      } else {
        const question = questionByKey.get(node.on);
        /* Free text is whatever the caller said, in their words. No `equals` can be written
           against it that a real answer will match, so every call would take `otherwise` and
           the branch would be decoration. Amounts and quantities are numbers, choices are
           one of a list, and everything else is a value with a shape — all of those can be
           branched on. */
        if (question?.type === "text") {
          problems.push(problem(
            node.id,
            "decide-on-free-text",
            `This step branches on "${node.on}", which is a free-text answer. Nothing a caller says in their own words will match a branch exactly, so every call would take "anything else". Make that question a choice with the answers listed.`,
          ));
        }
        /* A choice offers listed answers, and the model records exactly one of them. A branch
           naming an answer not on the list can never be taken; a typo here is a branch nobody
           reaches and nothing says so. */
        if (question?.type === "choice") {
          const offered = new Set(question.options.map(lower));
          for (const edge of leaving.get(node.id) ?? []) {
            const named =
              edge.when === undefined ? []
              : "equals" in edge.when ? [edge.when.equals]
              : "oneOf" in edge.when ? [...edge.when.oneOf]
              : [];
            const missing = named.filter((value) => !offered.has(lower(value)));
            if (missing.length > 0) {
              problems.push(problem(
                node.id,
                "branch-value-not-an-option",
                `A branch here waits for "${missing.join('", "')}", but the question it reads only offers ${question.options.map((o) => `"${o}"`).join(", ")}. That branch would never be taken.`,
                false,
              ));
            }
          }
        }
      }

      /* Branches are tried in order and the first match wins, so a later branch that an
         earlier one already catches is a branch that looks live on the canvas and never runs.
         Reported on the decide, and the message names both. */
      const conditional = (leaving.get(node.id) ?? []).filter((edge) => edge.when !== undefined);
      for (let later = 1; later < conditional.length; later += 1) {
        const behind = conditional[later]?.when;
        if (behind === undefined) continue;
        for (let earlier = 0; earlier < later; earlier += 1) {
          const ahead = conditional[earlier]?.when;
          if (ahead === undefined || !shadows(ahead, behind)) continue;
          problems.push(problem(
            node.id,
            "shadowed-branch",
            `Branch ${later + 1} out of this step (${describe(behind)}) is already caught by branch ${earlier + 1} (${describe(ahead)}), so it will never be taken. Reorder them or narrow the earlier one.`,
            false,
          ));
          break;
        }
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

  /* A confirm step splits on whether the caller agreed to a read-back of an answer. A question
     configured `confirm: "none"` is never read back, so nothing ever confirms it and the step
     can only say no. That is not a broken graph — it may be the operator's intent — but it is
     a step that looks like a decision and is not one. */
  for (const node of flow.nodes) {
    if (node.kind !== "confirm" || !reachable.has(node.id)) continue;
    if (node.on === undefined || node.on === "") {
      problems.push(problem(
        node.id,
        "decide-on-missing-field",
        "This step checks whether the caller confirmed an answer, but never says which answer.",
      ));
      continue;
    }
    const question = questionByKey.get(node.on);
    if (question !== undefined && question.confirm === "none") {
      problems.push(problem(
        node.id,
        "confirm-on-unconfirmed-field",
        `This step checks whether the caller confirmed "${node.on}", but that question is set never to be read back, so it can only ever take its "no" branch. Set the question to read back, or branch on something else.`,
        false,
      ));
    }
  }

  /* Duplicate keys, but only where both steps can run on one call. Two questions saving the
     same answer on opposite arms of a branch never both run, and one answer slot is exactly
     what they should share — a caller answers "budget" once whichever arm they are on. On one
     path, the second would silently write over the first. Unreachable steps are left out, as
     they are from the projection: a key on no path collides with nothing. */
  const collects = reachableNodes(flow).filter((node) => node.kind === "collect");
  for (let later = 1; later < collects.length; later += 1) {
    const node = collects[later];
    const key = node === undefined ? undefined : savedBy(node);
    if (node === undefined || key === undefined) continue;
    const earlier = collects
      .slice(0, later)
      .find((other) => savedBy(other) === key && canBothRun(flow, other.id, node.id));
    if (earlier === undefined) continue;
    problems.push(problem(
      node.id,
      "duplicate-field-key",
      `An earlier step on the same route already saves its answer as "${key}", so this one would write over it and the first answer would be lost.`,
    ));
  }

  const distinctKeys = new Set<string>();
  for (const node of flow.nodes) {
    if (node.kind !== "collect") continue;
    const key = savedBy(node);
    if (key === undefined) {
      problems.push(problem(
        node.id,
        "collect-without-field",
        "This step is meant to ask the caller something, but no question has been written on it, so the call would stop here with nothing to say.",
      ));
      continue;
    }
    if (reachable.has(node.id)) distinctKeys.add(key);
  }

  // Graph-level, so it lands on no node: no single step is at fault and pinning it on an
  // arbitrary one would send the operator to delete the wrong question. Counted the way the
  // projection counts — distinct keys among reachable steps — so this refuses exactly the
  // graphs whose projection would not fit, and not one more.
  if (distinctKeys.size > MAX_FLOW_FIELDS) {
    problems.push(problem(
      null,
      "too-many-fields",
      `This flow asks ${distinctKeys.size} questions and a call can only carry ${MAX_FLOW_FIELDS}, so the answers past that would have nowhere to go.`,
    ));
  }

  return problems;
};
