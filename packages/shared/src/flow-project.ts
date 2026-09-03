/**
 * The graph, flattened to the ordered question list the rest of the product already reads.
 *
 * Seventeen files read `agents.capturedFields`: the Collected data page builds its columns
 * from it, the field builder edits it, `captured-fields.ts` and `call-settings.ts` hand it to
 * a live call, and both the draft and the publish carry it. A graph-authored agent has to
 * populate that list or all of it stops working. So the graph is the source of truth and the
 * list is a projection, written once on publish — never a second, drifting copy an operator
 * can edit behind the canvas's back.
 *
 * Pure, and imports nothing but the contract next door: the API projects on publish and the
 * console projects to fill dropdowns, and a projection that disagreed between them would show
 * an operator one order and record another.
 *
 * The projection never truncates at `MAX_FLOW_FIELDS`. A graph over the cap is a blocking
 * validator problem, and refusing the publish tells the operator which question was too many;
 * silently dropping the forty-first would lose it on a call instead.
 */

import type { Flow, FlowField, FlowNode } from "./flow";

/**
 * Canvas order, and deliberately not insertion order.
 *
 * Where a branch leaves two questions genuinely unordered, something has to break the tie, and
 * the only tiebreak an operator can see is where the nodes sit. Insertion order is invisible:
 * it would mean re-dragging a node changes nothing while re-creating it silently reorders the
 * Collected data table. Reading order on a canvas is top-down then left-to-right, so y first,
 * then x, then the id — which is arbitrary but stable, and only decides exact overlaps.
 */
const byPosition = (a: FlowNode, b: FlowNode): number =>
  a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const collectedKey = (node: FlowNode | undefined): string | undefined =>
  node?.kind === "collect" ? node.field?.key : undefined;

interface Graph {
  readonly byId: ReadonlyMap<string, FlowNode>;
  readonly successors: ReadonlyMap<string, ReadonlySet<string>>;
  readonly predecessors: ReadonlyMap<string, ReadonlySet<string>>;
  /** Only what a call can actually get to. Everything below works on this set alone. */
  readonly reachable: ReadonlySet<string>;
  readonly start: FlowNode | undefined;
}

const readGraph = (flow: Flow): Graph => {
  const byId = new Map<string, FlowNode>();
  for (const node of flow.nodes) if (!byId.has(node.id)) byId.set(node.id, node);

  const successors = new Map<string, Set<string>>();
  const predecessors = new Map<string, Set<string>>();
  for (const id of byId.keys()) {
    successors.set(id, new Set());
    predecessors.set(id, new Set());
  }
  for (const edge of flow.edges) {
    // An edge to a deleted node is `edge-to-nowhere` to the validator. Here it is simply not a
    // route a call can take, so it carries no ordering and no reachability.
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    // Two ports landing on the same node — a decide's `yes` and `otherwise`, say — are one
    // dependency, not two. Held as sets so parallel edges cannot skew the ordering.
    successors.get(edge.from)?.add(edge.to);
    predecessors.get(edge.to)?.add(edge.from);
  }

  // `many-starts` is the validator's problem to refuse. Picking the topmost keeps this
  // function total and deterministic in the meantime, which is what the console needs while
  // the operator is still mid-edit.
  const start = [...byId.values()].filter((node) => node.kind === "start").sort(byPosition)[0];

  const reachable = new Set<string>();
  const pending = start ? [start.id] : [];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    for (const next of successors.get(id) ?? []) pending.push(next);
  }

  return { byId, successors, predecessors, reachable, start };
};

/**
 * Reachable nodes in the order a call would meet them.
 *
 * Kahn's algorithm, taking the topmost-leftmost of the currently available nodes rather than
 * whichever came off the queue first. Topological rather than depth-first on purpose: where
 * two branches rejoin, depth-first would emit the join while walking the first arm and put its
 * question ahead of the second arm's, even though every call collects that arm first.
 */
const walk = (graph: Graph): readonly FlowNode[] => {
  const waiting = new Map<string, number>();
  const ready: FlowNode[] = [];
  for (const id of graph.reachable) {
    const node = graph.byId.get(id);
    if (!node) continue;
    let count = 0;
    for (const pred of graph.predecessors.get(id) ?? []) if (graph.reachable.has(pred)) count += 1;
    // The call begins at `start` whatever points back at it, so a loop home must not stall the
    // whole walk on its first step.
    const blocked = id === graph.start?.id ? 0 : count;
    waiting.set(id, blocked);
    if (blocked === 0) ready.push(node);
  }

  const order: FlowNode[] = [];
  while (ready.length > 0) {
    ready.sort(byPosition);
    const node = ready.shift();
    if (!node) break;
    order.push(node);
    for (const next of graph.successors.get(node.id) ?? []) {
      if (!graph.reachable.has(next) || next === node.id) continue;
      const left = (waiting.get(next) ?? 0) - 1;
      waiting.set(next, left);
      const ahead = graph.byId.get(next);
      if (left === 0 && ahead) ready.push(ahead);
    }
  }

  // A cycle is a blocking validator problem, so this never reaches a published document. It
  // exists because the console projects on every keystroke: an operator halfway through wiring
  // a loop should see their questions in a stable order, not watch them vanish.
  const emitted = new Set(order.map((node) => node.id));
  const stranded = [...graph.reachable]
    .filter((id) => !emitted.has(id))
    .map((id) => graph.byId.get(id))
    .filter((node): node is FlowNode => node !== undefined)
    .sort(byPosition);

  return [...order, ...stranded];
};

/**
 * The graph's questions, in the order a call asks them.
 *
 * Deterministic by construction: the same graph projects to the same list byte for byte, so a
 * publish with no edits is not recorded as a change.
 *
 * Unreachable `collect` nodes do not contribute, and that is a real trade-off. Against
 * excluding them: unwire one node and a column quietly disappears from Collected data, taking
 * the operator's history with it visually even though the captures are still stored. For
 * excluding them, and decisively: this list is not only a display. `call-settings.ts` hands it
 * to the prompt layer, so every key here is a question the agent may be told to ask. Including
 * an unreachable node would have the agent ask, on a live call, a question the graph says is
 * on no path — a caller hearing a question that leads nowhere is worse than an operator seeing
 * a column go. The console warns first either way: `unreachable` is already a validator problem
 * shown against the node before anyone can publish.
 *
 * Duplicate keys are `duplicate-field-key` to the validator and blocked, but the first
 * occurrence still wins here rather than emitting the key twice — the consumers key off `key`,
 * and two identical columns would be a worse failure than the one the validator describes.
 */
export const projectToCapturedFields = (flow: Flow): readonly FlowField[] => {
  const fields: FlowField[] = [];
  const seen = new Set<string>();
  for (const node of walk(readGraph(flow))) {
    const key = collectedKey(node);
    if (key === undefined || seen.has(key) || !node.field) continue;
    seen.add(key);
    fields.push(node.field);
  }
  return fields;
};

/**
 * The field keys collected on *every* path that reaches this node.
 *
 * Intersection across incoming paths, never union. This populates a decide node's "branch on"
 * dropdown, and a union would offer a field collected only down the other arm — the branch
 * would then read an empty value on half its calls, which looks like a bug in the caller's
 * answer rather than in the wiring.
 *
 * A node's own field is not collected before it, so a collect node never offers itself.
 * An unreachable node gets nothing: no path reaches it, so nothing is guaranteed.
 */
export const fieldsCollectedBefore = (flow: Flow, nodeId: string): ReadonlySet<string> => {
  const graph = readGraph(flow);
  const startId = graph.start?.id;
  if (!graph.reachable.has(nodeId) || nodeId === startId) return new Set();

  const universe = new Set<string>();
  for (const id of graph.reachable) {
    const key = collectedKey(graph.byId.get(id));
    if (key !== undefined) universe.add(key);
  }

  // A "must" analysis, so every node starts optimistic and only ever loses keys. Starting from
  // everything is what makes a loop converge on the right answer instead of on nothing: a node
  // inside a cycle would otherwise intersect against its own not-yet-computed self and empty.
  const before = new Map<string, Set<string>>();
  for (const id of graph.reachable) before.set(id, id === startId ? new Set() : new Set(universe));

  let settled = false;
  while (!settled) {
    settled = true;
    for (const id of graph.reachable) {
      if (id === startId) continue;
      const next = new Set<string>();
      let seeded = false;
      for (const pred of graph.predecessors.get(id) ?? []) {
        if (!graph.reachable.has(pred)) continue;
        const leaving = new Set(before.get(pred) ?? []);
        const key = collectedKey(graph.byId.get(pred));
        if (key !== undefined) leaving.add(key);
        if (!seeded) {
          for (const held of leaving) next.add(held);
          seeded = true;
          continue;
        }
        for (const held of [...next]) if (!leaving.has(held)) next.delete(held);
      }
      const current = before.get(id);
      const changed =
        !current || current.size !== next.size || [...next].some((held) => !current.has(held));
      if (changed) {
        before.set(id, next);
        settled = false;
      }
    }
  }

  return before.get(nodeId) ?? new Set();
};
