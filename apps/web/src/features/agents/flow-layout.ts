import type { Flow, FlowEdge, FlowNode } from "./flow.schema";

/**
 * Where the steps sit, which service each belongs to, and which of them are folded away.
 *
 * All of it is derived, and that is the point. Positions used to be authored — you dragged a
 * card and the coordinates were saved — which meant every graph carried a layout somebody
 * had to maintain, a "Tidy up" button to repair it, and the standing possibility of a flow
 * that was correct and unreadable. Deriving the layout from the graph removes all three:
 * there is nothing to arrange, so nothing can be untidy.
 *
 * A *service* is a named group of steps — "rent", "book a viewing" — and it is the one thing
 * here that is not derived, because it cannot be. It used to be: a service was whatever one
 * branch of the first fork reached and nothing else did. That made two things impossible
 * that a business needs. A service could not exist until something led to it, so adding one
 * meant wiring it to the fork whether or not that was wanted; and a branch inside one service
 * could not lead to another without the drawing deciding the second service was now part of
 * the first. So each step carries the name of its service (`FlowNode.service`), the lanes are
 * those names, and a link between two services is drawn as a link and changes nothing about
 * where anything sits. Flows saved before services were named are read the old way once, on
 * the way in (`withServiceTags`), and carry names from then on.
 *
 * Kept out of the canvas component so both can be tested without a DOM, because the layout
 * stopped being cosmetic the moment it became the only layout there is.
 */

/**
 * Card geometry. The canvas draws at these, so a change here moves the drawing.
 *
 * A card is one line — an icon, the question, a small subtitle — so the rows are close: the
 * drawing should read as a list of what is said, not as a diagram of boxes. `LANE_GAP` is
 * the extra room after the first fork, where the fan of links lands on the lane headers.
 */
export const COLUMN = 236;
export const ROW = 66;
/** Below the toolbar along the top edge of the drawing, with a lane header's room above the first card. */
export const TOP = 92;
export const LEFT = 40;
export const LANE_GAP = 46;
/** A lane's header row, drawn above its first card: the name, and how many steps. */
export const LANE_HEAD = 30;
/** Extra room below the lanes before the shared close, for the links that rejoin to run along. */
export const REJOIN_GAP = 22;

/* ------------------------------------------------------------------ the graph */

const byId = (flow: Flow, id: string): FlowNode | undefined => flow.nodes.find((node) => node.id === id);

/** Every step reachable from the answer, pretending the named steps are not there. */
const reachableWithout = (flow: Flow, absent: ReadonlySet<string>): ReadonlySet<string> => {
  const start = flow.nodes.find((node) => node.kind === "start") ?? flow.nodes[0];
  const seen = new Set<string>();
  if (start === undefined || absent.has(start.id)) return seen;
  const queue = [start.id];
  seen.add(start.id);
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) continue;
    for (const edge of flow.edges) {
      if (edge.from !== id || absent.has(edge.to) || seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return seen;
};

/**
 * How far down the page each step sits: the longest path from the answer, not the shortest.
 *
 * Breadth-first gives a step the row of the quickest way to it, which puts a shared closing
 * line level with the arm that took the long way round — two arms rejoining, drawn side by
 * side, with the link between them running sideways instead of down. Relaxing to the longest
 * path puts a rejoin below everything that reaches it, which is the whole reason the drawing
 * reads as a call.
 *
 * Bounded by the node count because a graph reaching here has been validated by nobody: a
 * cycle would otherwise relax forever. It settles at the cap and still draws.
 */
export const depths = (flow: Flow): ReadonlyMap<string, number> => {
  const first = flow.nodes.find((node) => node.kind === "start") ?? flow.nodes[0];
  const reached = reachableWithout(flow, new Set());
  const depth = new Map<string, number>();
  if (first !== undefined) depth.set(first.id, 0);

  for (let pass = 0; pass < reached.size; pass += 1) {
    let moved = false;
    for (const edge of flow.edges) {
      const from = depth.get(edge.from);
      if (from === undefined || !reached.has(edge.to)) continue;
      if ((depth.get(edge.to) ?? -1) < from + 1) {
        depth.set(edge.to, from + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return depth;
};

/** The shallowest reachable `decide`: where the call first splits into services. */
const firstFork = (flow: Flow, depth: ReadonlyMap<string, number>): FlowNode | undefined =>
  flow.nodes
    .filter((node) => node.kind === "decide" && depth.has(node.id))
    .sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0))[0];

/** The name of each kind's first port, where it has one. Mirrors `portsOf` on the canvas. */
const FIRST_PORT: Partial<Record<FlowNode["kind"], string>> = { collect: "got", confirm: "yes", tool: "ok" };

/**
 * The edge a step leaves by when nothing else is said: the first port's, which is the one
 * a link with no port name belongs to. A `decide` has no default; every way out is named.
 */
const defaultEdgeFrom = (flow: Flow, id: string): FlowEdge | undefined => {
  const node = byId(flow, id);
  if (node === undefined || node.kind === "decide") return undefined;
  return flow.edges.find((edge) => edge.from === id && edge.when === undefined && edge.otherwise === undefined && (edge.port === undefined || edge.port === FIRST_PORT[node.kind]));
};

/** Every step reached from here by following each step's default way out, and no branch arms. */
const alongDefaults = (flow: Flow, start: string): ReadonlySet<string> => {
  const seen = new Set<string>([start]);
  let at: string | undefined = defaultEdgeFrom(flow, start)?.to;
  while (at !== undefined && !seen.has(at)) {
    seen.add(at);
    at = defaultEdgeFrom(flow, at)?.to;
  }
  seen.delete(start);
  return seen;
};

/**
 * Whether a branch points straight at the step the services converge on rather than at a
 * service of its own — which is what a service emptied of its steps looks like.
 *
 * True when every other branch walks to it along their default ways out. A service that ends
 * the call itself never reaches it, and then the step really is only reachable through this
 * branch, which is the same as saying it belongs to it.
 */
const converges = (flow: Flow, target: string, targets: readonly string[]): boolean => {
  const others = targets.filter((other) => other !== target);
  return others.length > 0 && others.every((other) => alongDefaults(flow, other).has(target));
};

/** The choice a fork reads, when it is one: the `collect` step whose field the fork is on. */
const choiceOf = (flow: Flow, fork: FlowNode) => {
  const field = flow.nodes.find((n) => n.kind === "collect" && n.field !== undefined && n.field.key === fork.on)?.field;
  return field !== undefined && field.type === "choice" ? field : undefined;
};

/** The answer a fork's edge carries, worded the way the lanes are. */
const answerOf = (edge: FlowEdge): string =>
  edge.otherwise === true ? "anything else" : edge.when !== undefined && "equals" in edge.when ? edge.when.equals : (edge.port ?? "next");

/**
 * What the catch-all is called. Named by the one option the named branches leave uncovered
 * when there is exactly one — a template's "rent or buy" draws buy as the catch-all so the
 * fork can publish, and the lane should still say buy — and "anything else" otherwise.
 */
const catchAllName = (flow: Flow, fork: FlowNode): string => {
  const named = new Set(flow.edges.filter((edge) => edge.from === fork.id && edge.when !== undefined && "equals" in edge.when).map((edge) => (edge.when as { equals: string }).equals));
  const uncovered = (choiceOf(flow, fork)?.options ?? []).filter((option) => !named.has(option));
  return uncovered.length === 1 ? (uncovered[0] ?? "anything else") : "anything else";
};

/* ------------------------------------------------------------------ services */

/** The service a step says it is in, or nothing. An empty name is nothing. */
export const serviceOf = (node: FlowNode): string | undefined => {
  const name = node.service?.trim();
  return name === undefined || name === "" ? undefined : name;
};

const tagged = (node: FlowNode, service: string | undefined): FlowNode => {
  const { service: _was, ...rest } = node;
  return service === undefined ? rest : { ...rest, service };
};

/**
 * The services a flow had before it could name them, read off its shape.
 *
 * The old rule, kept for the flows that were saved under it: a service is what one branch of
 * the first fork reaches and nothing else does, labelled by the answer that gets there. A
 * link into a service's first step from anywhere but the fork is a jump and is set aside
 * first, or it would make the service look like part of whatever jumped.
 */
const derivedServices = (flow: Flow): readonly { readonly label: string; readonly ids: readonly string[] }[] => {
  const fork = firstFork(flow, depths(flow));
  if (fork === undefined) return [];
  const branches = flow.edges.filter((edge) => edge.from === fork.id);
  /* One branch is not a fork into services: the rest of the call after a lone catch-all is
     the rest of the call, not a service called "anything else". */
  if (branches.length < 2) return [];
  const targets = branches.map((edge) => edge.to);
  const heads = new Set(targets.filter((target) => !converges(flow, target, targets)));
  const spine: Flow = { ...flow, edges: flow.edges.filter((edge) => edge.from === fork.id || !heads.has(edge.to)) };
  const catchAll = catchAllName(flow, fork);
  return branches.flatMap((branch) => {
    const owned = !reachableWithout({ ...spine, edges: spine.edges.filter((edge) => edge !== branch) }, new Set()).has(branch.to);
    if (!owned) return [];
    return [{ label: branch.otherwise === true ? catchAll : answerOf(branch), ids: [branch.to, ...onlyReachableThrough(spine, branch.to)] }];
  });
};

/**
 * Every step named for its service, for a flow that was saved before steps had names.
 *
 * Only a flow with no names at all is read this way, and only the steps the old rule puts in
 * a service are named: the opening and the close belong to everybody and stay unnamed. A
 * flow with any name on it is already speaking the new language, and its unnamed steps are
 * shared on purpose — reading them the old way would, once a service was removed, fold the
 * close into whichever service was left. The same flow object comes back when there is
 * nothing to do, so a caller can tell.
 */
export const withServiceTags = (flow: Flow): Flow => {
  if (flow.nodes.some((node) => serviceOf(node) !== undefined)) return flow;
  const derived = new Map<string, string>();
  for (const service of derivedServices(flow)) for (const id of service.ids) derived.set(id, service.label);
  if (!flow.nodes.some((node) => serviceOf(node) === undefined && derived.has(node.id))) return flow;
  return { ...flow, nodes: flow.nodes.map((node) => (serviceOf(node) === undefined && derived.has(node.id) ? tagged(node, derived.get(node.id)) : node)) };
};

/* ------------------------------------------------------------------ lanes */

/**
 * One labelled group of steps on the canvas — the shared opening, then a lane per service.
 *
 * A six-service front desk drawn as twenty-four cards is a wall, and the only way to tell
 * which service you are looking at is to trace links upward with your eyes. Naming those
 * groups on the drawing costs nothing and is the difference between a diagram and a business.
 */
export interface Lane {
  /**
   * `"opening"` for the shared questions; `svc:<name>` for a service; `via:<answer>` for a
   * branch of the fork that leads to no service of its own — every step it had has been moved
   * away and it points at the shared close — which is drawn empty so it can be filled again.
   */
  readonly id: string;
  readonly label: string;
  /** The steps in this lane, the first one first. Empty for a `via:` lane. */
  readonly ids: readonly string[];
  /** The fork the lanes hang off. Absent when the call never forks. */
  readonly fork?: string;
  /** The lane's first step — or, for a `via:` lane, the shared step its branch points at. */
  readonly head?: string;
  /** The branch the call takes when the answer is none of the named ones. */
  readonly catchAll?: true;
}

interface Analysis {
  readonly flow: Flow;
  readonly lanes: readonly Lane[];
  readonly laneOf: ReadonlyMap<string, Lane>;
  readonly fork: FlowNode | undefined;
  readonly jumps: ReadonlySet<FlowEdge>;
  readonly spine: Flow;
  /** Every step's row. Reachable steps by longest path; the rest seeded per lane. */
  readonly rows: ReadonlyMap<string, number>;
  readonly forkDepth: number;
  /** The row the lanes' first cards sit on. */
  readonly laneTop: number;
  /** The deepest row any lane reaches; everything shared below it drops by the rejoin gap. */
  readonly laneFloor: number;
}

const analysed = new WeakMap<Flow, Analysis>();

/** The first step of a group: one no other step in the group leads to, or the first listed. */
const headOf = (flow: Flow, ids: readonly string[]): string | undefined => {
  const inside = new Set(ids);
  return ids.find((id) => !flow.edges.some((edge) => edge.to === id && inside.has(edge.from))) ?? ids[0];
};

/** A group's steps with the first one first, then along each step's default way out, then the rest. */
const inOrder = (flow: Flow, ids: readonly string[]): readonly string[] => {
  const head = headOf(flow, ids);
  if (head === undefined) return [];
  const inside = new Set(ids);
  const ordered: string[] = [head];
  const seen = new Set(ordered);
  let at: string | undefined = defaultEdgeFrom(flow, head)?.to;
  while (at !== undefined && inside.has(at) && !seen.has(at)) {
    ordered.push(at);
    seen.add(at);
    at = defaultEdgeFrom(flow, at)?.to;
  }
  for (const id of ids) if (!seen.has(id)) ordered.push(id);
  return ordered;
};

/**
 * Everything the drawing needs to know about a flow, worked out once per flow object.
 *
 * The services come from the steps' names; the fork's branches say which of them are
 * attached and which branch is the catch-all; the links between services are the jumps; the
 * spine is the flow without them; the rows come from the spine — reachable steps by longest
 * path, and the steps of a service nothing leads to yet from the top of the lanes down.
 */
const analyse = (input: Flow): Analysis => {
  const cached = analysed.get(input);
  if (cached !== undefined) return cached;

  const flow = withServiceTags(input);
  const fullDepth = depths(flow);
  const fork = firstFork(flow, fullDepth);

  /* Service lanes, in the order their names first appear among the steps — which is the
     order they were added in, and the order a reorder writes. */
  const names: string[] = [];
  const members = new Map<string, string[]>();
  for (const node of flow.nodes) {
    const name = serviceOf(node);
    if (name === undefined) continue;
    if (!members.has(name)) {
      names.push(name);
      members.set(name, []);
    }
    members.get(name)?.push(node.id);
  }
  const services: Lane[] = names.map((label) => {
    const ids = inOrder(flow, members.get(label) ?? []);
    return { id: `svc:${label}`, label, ids, ...(fork === undefined ? {} : { fork: fork.id }), ...(ids[0] === undefined ? {} : { head: ids[0] }) };
  });
  const laneOf = new Map<string, Lane>();
  for (const lane of services) for (const id of lane.ids) laneOf.set(id, lane);

  /* The fork's branches: one into a service marks it attached (and the catch-all); one that
     leads to no service — every step it had moved away, so it points past where they were at
     the shared close — is a service with nothing in it, drawn empty so a step can be dropped
     back into it. */
  const lanes: Lane[] = [...services];
  if (fork !== undefined) {
    const branches = flow.edges.filter((edge) => edge.from === fork.id);
    const catchAll = catchAllName(flow, fork);
    for (const branch of branches) {
      const into = laneOf.get(branch.to);
      if (into !== undefined) {
        if (branch.otherwise === true) {
          const at = lanes.indexOf(into);
          const marked: Lane = { ...into, catchAll: true };
          lanes[at] = marked;
          for (const id of marked.ids) laneOf.set(id, marked);
        }
        continue;
      }
      const label = branch.otherwise === true ? catchAll : answerOf(branch);
      lanes.push({ id: `via:${label}`, label, ids: [], fork: fork.id, head: branch.to, ...(branch.otherwise === true ? { catchAll: true as const } : {}) });
    }
  }

  /* A jump: a link into a service from anywhere but the fork and the service itself. The
     services stay where their names put them; the jump is drawn over the drawing. */
  const jumps = new Set<FlowEdge>();
  for (const edge of flow.edges) {
    if (fork !== undefined && edge.from === fork.id) continue;
    const to = laneOf.get(edge.to);
    if (to === undefined) continue;
    if (laneOf.get(edge.from) !== to) jumps.add(edge);
  }
  const spine: Flow = jumps.size === 0 ? flow : { ...flow, edges: flow.edges.filter((edge) => !jumps.has(edge)) };

  const depth = depths(spine);
  const forkDepth = fork === undefined ? Infinity : (depth.get(fork.id) ?? Infinity);
  const unreached = Math.max(0, ...[...depth.values()].map((value) => value + 1));
  const laneTop = fork === undefined ? 1 : forkDepth + 1;

  /* Rows for what the spine never reaches: a service nothing leads to yet starts at the top
     of the lanes like every other; anything else goes below the end, where it reads as the
     unreachable thing it is. Longest path from those seeds, the same way as from the start. */
  const rows = new Map(depth);
  const loose = flow.nodes.filter((node) => !rows.has(node.id));
  const looseIds = new Set(loose.map((node) => node.id));
  for (const node of loose) {
    const root = !spine.edges.some((edge) => edge.to === node.id && looseIds.has(edge.from));
    if (root) rows.set(node.id, laneOf.has(node.id) ? laneTop : unreached);
  }
  for (let pass = 0; pass < loose.length + 1; pass += 1) {
    let moved = false;
    for (const edge of spine.edges) {
      if (!looseIds.has(edge.to)) continue;
      const from = rows.get(edge.from);
      if (from === undefined) continue;
      if ((rows.get(edge.to) ?? -1) < from + 1) {
        rows.set(edge.to, from + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (const node of loose) if (!rows.has(node.id)) rows.set(node.id, laneOf.has(node.id) ? laneTop : unreached);

  const laneFloor = Math.max(forkDepth === Infinity ? 0 : forkDepth, ...flow.nodes.filter((node) => laneOf.has(node.id)).map((node) => rows.get(node.id) ?? 0));

  const opening: Lane = {
    id: "opening",
    label: "everyone gets this",
    ids: flow.nodes.filter((node) => !laneOf.has(node.id) && (depth.get(node.id) ?? Infinity) <= forkDepth).map((node) => node.id),
  };
  const all = lanes.length === 0 && fork === undefined ? [] : [opening, ...lanes];

  const analysis: Analysis = { flow, lanes: all, laneOf, fork, jumps, spine, rows, forkDepth, laneTop, laneFloor };
  analysed.set(input, analysis);
  analysed.set(flow, analysis);
  return analysis;
};

/**
 * The lanes, or none at all.
 *
 * None when the call never forks and no service is named: a straight line has one lane, and
 * drawing a box round the whole drawing to say so is a label that tells nobody anything.
 */
export const laneGroups = (flow: Flow): readonly Lane[] => analyse(flow).lanes;

/** The links that leave one service for another: drawn, but not part of the drawing's structure. */
export const jumpEdges = (flow: Flow): ReadonlySet<FlowEdge> => analyse(flow).jumps;

/** The branch heads: every step a `decide` leads to, labelled by the answer that gets there. */
export const branchHeads = (
  flow: Flow,
  decide: FlowNode,
): readonly { readonly to: string; readonly label: string; readonly edge: FlowEdge }[] =>
  flow.edges.filter((edge) => edge.from === decide.id).map((edge) => ({ to: edge.to, edge, label: answerOf(edge) }));

/** The edge from the fork that this lane is: the branch that leads into it. */
export const branchEdgeOf = (flow: Flow, lane: Lane): FlowEdge | undefined => {
  if (lane.fork === undefined) return undefined;
  const inside = new Set(lane.ids);
  return flow.edges.find((edge) => {
    if (edge.from !== lane.fork) return false;
    if (inside.size > 0) return inside.has(edge.to);
    return edge.to === lane.head && (lane.catchAll === true ? edge.otherwise === true : answerOf(edge) === lane.label);
  });
};

/* ------------------------------------------------------------------ layout */

/**
 * The columns: which lane each step is in, how wide each lane is, and where each lane starts.
 *
 * Columns follow lanes, not rows. Centring every row on its own put the second row of three
 * lanes in the gaps between the first — each lane's cards wandering towards the middle as the
 * lanes below it got fewer — and a lane drawn round that overlapped its neighbour. So each
 * service owns a run of columns as wide as its widest row, the lanes sit side by side, and
 * everything outside a lane — the opening, the rejoin, the unreachable — is centred across
 * all of them. A service with no steps in it yet still owns a column, so it has somewhere
 * to be drawn and something to drop a step onto. A flow with services but no fork puts the
 * shared column first and the services beside it, since there is nothing for them to hang from.
 */
const columns = (input: Flow) => {
  const a = analyse(input);
  const { flow, lanes, rows, forkDepth, laneFloor } = a;
  const rowOf = (id: string): number => rows.get(id) ?? 0;
  const laneIndex = new Map<string, number>();
  lanes.forEach((lane, at) => {
    if (lane.id === "opening") return;
    for (const id of lane.ids) laneIndex.set(id, at);
  });
  /* A shared step whose row falls among the lanes' rows — reachable, in no service, and
     not the opening: a step hung off the fork by a bare link, say — cannot go in the centred
     shared column, which runs straight through the lanes there. Such steps take a column
     of their own beside the last lane, as a lane with no name. */
  const stray = lanes.length;
  const band = (row: number): boolean => row > forkDepth && row <= laneFloor;
  for (const node of flow.nodes) if (!laneIndex.has(node.id) && band(rowOf(node.id))) laneIndex.set(node.id, stray);

  /** Rows inside one lane (or the shared area, keyed -1): how many steps share each row. */
  const perLane = new Map<number, Map<number, number>>();
  const count = (lane: number, row: number): number => {
    const inLane = perLane.get(lane) ?? new Map<number, number>();
    const seen = (inLane.get(row) ?? 0) + 1;
    inLane.set(row, seen);
    perLane.set(lane, inLane);
    return seen - 1;
  };
  const across = new Map<string, number>();
  for (const node of flow.nodes) across.set(node.id, count(laneIndex.get(node.id) ?? -1, rowOf(node.id)));

  const widthOf = (lane: number): number => Math.max(1, ...(perLane.get(lane)?.values() ?? [1]));
  const sharedWidest = widthOf(-1);
  const hangs = a.fork !== undefined;
  const laneLeft: number[] = [];
  let total = hangs ? 0 : sharedWidest;
  lanes.forEach((lane, at) => {
    laneLeft[at] = total;
    if (lane.id !== "opening") total += widthOf(at);
  });
  if ([...laneIndex.values()].includes(stray)) {
    laneLeft[stray] = total;
    total += widthOf(stray);
  }
  const totalCols = hangs ? Math.max(total, sharedWidest) : total;
  const sharedCol = (inRow: number, at: number): number => (hangs ? (totalCols - inRow) / 2 + at : at);

  return { flow, lanes, laneIndex, perLane, across, widthOf, laneLeft, sharedCol, rowOf, forkDepth, laneFloor, laneTop: a.laneTop, hangs };
};

/**
 * Rows by distance from the answer, columns by lane.
 *
 * A fork reads as a fork rather than a staircase because the steps it leads to share a row.
 * Anything the walk never reaches goes in a row of its own below the end — which is also the
 * clearest way to see that a step is unreachable, without drawing a report about it.
 */
export const tidied = (input: Flow): Flow => {
  const c = columns(input);
  return {
    ...input,
    nodes: input.nodes.map((node) => {
      const row = c.rowOf(node.id);
      const at = c.across.get(node.id) ?? 0;
      const lane = c.laneIndex.get(node.id);
      const inRow = c.perLane.get(lane ?? -1)?.get(row) ?? 1;
      const col = lane === undefined ? c.sharedCol(inRow, at) : (c.laneLeft[lane] ?? 0) + (c.widthOf(lane) - inRow) / 2 + at;
      // Everything below the fork drops by the lane gap, so the fan and the lane headers fit;
      // everything shared below the lanes drops again, so the links that rejoin have a gap to run in.
      const y = TOP + row * ROW + (row > c.forkDepth ? LANE_GAP : 0) + (row > c.laneFloor && lane === undefined ? REJOIN_GAP : 0);
      return { ...node, x: LEFT + col * COLUMN, y };
    }),
  };
};

/**
 * Where each service's column starts and how wide it is, in pixels, with the row its first
 * step sits on. What the canvas draws a lane from when the lane has no cards to measure —
 * a branch whose steps were all dragged elsewhere.
 */
export const laneFrames = (input: Flow): readonly { readonly id: string; readonly left: number; readonly width: number; readonly top: number }[] => {
  const c = columns(input);
  const top = TOP + c.laneTop * ROW + (c.hangs ? LANE_GAP : 0);
  return c.lanes
    .map((lane, at) => ({ id: lane.id, left: LEFT + (c.laneLeft[at] ?? 0) * COLUMN, width: c.widthOf(at) * COLUMN, top }))
    .filter((frame) => frame.id !== "opening");
};

/** Whether every step sits where it sits in the other graph, to the pixel. */
export const samePlaces = (a: Flow, b: Flow): boolean => {
  const at = new Map(a.nodes.map((node) => [node.id, `${node.x},${node.y}`]));
  return a.nodes.length === b.nodes.length && b.nodes.every((node) => at.get(node.id) === `${node.x},${node.y}`);
};

/**
 * Place what an edit added, on a drawing arranged by hand, and move nothing else.
 *
 * A new step goes under the step that leads to it; the first step of a new service goes to
 * the right of everything; anything else goes under the lowest card. Nudged aside when that
 * spot is taken, so two steps added to one place do not sit on top of each other. The rest of
 * the drawing is the operator's and is not touched.
 */
export const placeNew = (before: Flow, after: Flow): Flow => {
  const known = new Set(before.nodes.map((node) => node.id));
  const fresh = after.nodes.filter((node) => !known.has(node.id));
  if (fresh.length === 0) return after;
  const placed = new Map(after.nodes.filter((node) => known.has(node.id)).map((node) => [node.id, { x: node.x, y: node.y }]));
  const taken = (x: number, y: number): boolean => [...placed.values()].some((p) => Math.abs(p.x - x) < 30 && Math.abs(p.y - y) < 30);
  const free = (x: number, y: number): { x: number; y: number } => {
    let spot = { x, y };
    for (let tries = 0; tries < 24 && taken(spot.x, spot.y); tries += 1) spot = { x: spot.x + 24, y: spot.y + 24 };
    return spot;
  };
  const right = Math.max(LEFT, ...[...placed.values()].map((p) => p.x + COLUMN));
  const bottom = Math.max(TOP, ...[...placed.values()].map((p) => p.y + ROW));
  for (const node of fresh) {
    const from = after.edges.find((edge) => edge.to === node.id && placed.has(edge.from));
    const anchor = from === undefined ? undefined : placed.get(from.from);
    const spot =
      anchor !== undefined
        ? free(anchor.x, anchor.y + ROW)
        : serviceOf(node) !== undefined && !before.nodes.some((other) => serviceOf(other) === serviceOf(node))
          ? free(right, TOP + ROW + LANE_GAP)
          : free(LEFT, bottom);
    placed.set(node.id, spot);
  }
  return { ...after, nodes: after.nodes.map((node) => (known.has(node.id) ? node : { ...node, ...placed.get(node.id) })) };
};

/**
 * Whether two graphs have the same steps, the same links and the same services.
 *
 * The test for "re-lay this out". Editing the words in a step must not move anything — a
 * card that jumps while you are typing in it is worse than an untidy one — so the layout
 * runs when the shape changes and not when the content does. Which service a step is in is
 * shape: it decides the column.
 */
export const sameShape = (a: Flow, b: Flow): boolean => {
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
  const services = new Map(a.nodes.map((node) => [node.id, serviceOf(node)]));
  if (b.nodes.some((node) => !services.has(node.id) || services.get(node.id) !== serviceOf(node))) return false;
  const links = new Set(a.edges.map((edge) => `${edge.from} ${edge.to} ${edge.port ?? ""}`));
  return b.edges.every((edge) => links.has(`${edge.from} ${edge.to} ${edge.port ?? ""}`));
};

/* ------------------------------------------------------------------ folding */

/**
 * The steps that exist only because of `head` — the ones a call can reach no other way.
 * Walk the graph with `head` removed, and whatever can no longer be reached belonged to it.
 */
export const onlyReachableThrough = (flow: Flow, head: string): ReadonlySet<string> => reachableOnlyVia(flow, new Set([head]));

/** What becomes unreachable once every one of `heads` is taken out, the heads excluded. */
const reachableOnlyVia = (flow: Flow, heads: ReadonlySet<string>): ReadonlySet<string> => {
  const whole = reachableWithout(flow, new Set());
  const without = reachableWithout(flow, heads);
  const only = new Set<string>();
  for (const id of whole) if (!heads.has(id) && !without.has(id)) only.add(id);
  return only;
};

/** The lane a fold key names: a lane id, or the id of any step in the lane. */
const laneFor = (a: Analysis, key: string): Lane | undefined => a.lanes.find((lane) => lane.id === key) ?? a.laneOf.get(key);

/**
 * Everything folded away by the collapsed services — worked out together, not one at a time.
 *
 * A folded service hides its own steps. A shared closing line that only folded services led
 * to goes with them, and no union of the services taken separately ever finds it: while any
 * one is open the close is reachable, so none considers it its own. Removing every folded
 * service at once is the only question with the right answer. On the spine, so a service
 * folds whole whether or not another jumps into it.
 */
export const foldedAway = (flow: Flow, collapsed: Iterable<string>): ReadonlySet<string> => {
  const a = analyse(flow);
  const gone = new Set<string>();
  for (const key of collapsed) for (const id of laneFor(a, key)?.ids ?? []) gone.add(id);
  if (gone.size === 0) return gone;
  for (const id of reachableOnlyVia(a.spine, gone)) if (!a.laneOf.has(id)) gone.add(id);
  return gone;
};

/** How many steps a folded service stands in for. */
export const foldedCount = (flow: Flow, head: string): number => laneFor(analyse(flow), head)?.ids.length ?? 0;

/* ------------------------------------------------------------------ growing it */

/**
 * Put a new step on the path right after `anchor`, in the anchor's service.
 *
 * Whatever the anchor led to, the new step now leads to instead — so a question dropped
 * between two others is asked between them, not left floating for somebody to wire. A step
 * that ends the call (a transfer, a hang-up) leads nowhere, and whatever used to follow is
 * cut loose: that is what dropping an ending there means, and the drawing shows the rest as
 * unreachable rather than pretending. A new branch takes over the old link as its catch-all,
 * which is the one way out a branch must have before it can be published.
 */
/* Every edit below reads a named flow (`withServiceTags`), so a flow that is partly named never
   comes out of one; and every refusal hands back the very object it was given, which is how
   the canvas tells an edit that did nothing from one that did. */
export const insertAfter = (input: Flow, anchor: string, fresh: FlowNode): Flow => {
  const flow = withServiceTags(input);
  const out = defaultEdgeFrom(flow, anchor);
  const ends = fresh.kind === "transfer" || fresh.kind === "hangup";
  const edges = flow.edges.filter((edge) => edge !== out);
  /* After a fork means by a new arm of it — a fork has no default way out, and a bare link
     from one is a link the director cannot take. The arm's answer is left to fill in. */
  const fromFork = byId(flow, anchor)?.kind === "decide";
  const toAnchor: FlowEdge = out === undefined ? (fromFork ? { from: anchor, to: fresh.id, when: { equals: "" } } : { from: anchor, to: fresh.id }) : { ...out, to: fresh.id };
  const onward: FlowEdge[] =
    out === undefined || ends
      ? []
      : fresh.kind === "decide"
        ? [{ from: fresh.id, to: out.to, otherwise: true }]
        : [{ from: fresh.id, to: out.to }];
  const placed = tagged(fresh, serviceOf(byId(flow, anchor) ?? fresh));
  return { ...flow, nodes: [...flow.nodes, placed], edges: [...edges, toAnchor, ...onward] };
};

/**
 * Put a new step on the path right before `anchor`, in the anchor's service: everything that
 * led to the anchor now leads to the new step, and the new step leads to the anchor. Used for
 * the top of a service and for the opening lane, whose last step is the fork — a question
 * dropped there is asked before the call splits. Nothing goes before the answer.
 */
export const insertBefore = (input: Flow, anchor: string, fresh: FlowNode): Flow => {
  const flow = withServiceTags(input);
  if (fresh.kind === "transfer" || fresh.kind === "hangup") return insertAfter(flow, anchor, fresh);
  const at = byId(flow, anchor);
  if (at?.kind === "start") return insertAfter(flow, anchor, fresh);
  const edges = flow.edges.map((edge) => (edge.to === anchor ? { ...edge, to: fresh.id } : edge));
  const onward: FlowEdge = fresh.kind === "decide" ? { from: fresh.id, to: anchor, otherwise: true } : { from: fresh.id, to: anchor };
  return { ...flow, nodes: [...flow.nodes, tagged(fresh, at === undefined ? serviceOf(fresh) : serviceOf(at))], edges: [...edges, onward] };
};

/** The last step of a lane, following each step's default way out while it stays in the lane. */
export const laneTail = (flow: Flow, lane: Lane): string | undefined => {
  if (lane.id === "opening" || lane.head === undefined || lane.ids.length === 0) return undefined;
  const inLane = new Set(lane.ids);
  let at: string = lane.head;
  for (let steps = 0; steps < lane.ids.length; steps += 1) {
    const next: string | undefined = defaultEdgeFrom(flow, at)?.to;
    if (next === undefined || !inLane.has(next)) return at;
    at = next;
  }
  return at;
};

/**
 * Add a step to a lane. On the opening lane that means before the fork, since the fork is
 * the lane's last step and a question dropped there belongs to everybody; on a service it
 * means after the service's last step. A service with nothing in it yet gets its first step,
 * and if a branch of the fork leads to the service's place, the step goes on the branch.
 */
export const appendToLane = (input: Flow, lane: Lane, fresh: FlowNode): Flow => {
  const flow = withServiceTags(input);
  if (lane.id === "opening") {
    const fork = lane.ids.find((id) => byId(flow, id)?.kind === "decide");
    const loose = tagged(fresh, undefined);
    return fork === undefined ? { ...flow, nodes: [...flow.nodes, loose] } : insertBefore(flow, fork, loose);
  }
  const named = tagged(fresh, lane.label);
  if (lane.ids.length === 0) {
    const branch = branchEdgeOf(flow, lane);
    if (branch === undefined) return { ...flow, nodes: [...flow.nodes, named] };
    const ends = fresh.kind === "transfer" || fresh.kind === "hangup";
    const onward: FlowEdge[] = ends ? [] : fresh.kind === "decide" ? [{ from: named.id, to: branch.to, otherwise: true }] : [{ from: named.id, to: branch.to }];
    return { ...flow, nodes: [...flow.nodes, named], edges: [...flow.edges.map((edge) => (edge === branch ? { ...edge, to: named.id } : edge)), ...onward] };
  }
  const tail = laneTail(flow, lane);
  return tail === undefined ? { ...flow, nodes: [...flow.nodes, named] } : insertAfter(flow, tail, named);
};

/**
 * Where the services meet again: the first step outside every lane that a lane's last step
 * leads to. Undefined when every service ends the call itself.
 */
export const rejoinPoint = (flow: Flow, lanes: readonly Lane[]): string | undefined => {
  const inAnyLane = new Set(lanes.flatMap((lane) => lane.ids));
  for (const lane of lanes) {
    if (lane.id === "opening") continue;
    const tail = laneTail(flow, lane);
    const next = tail === undefined ? undefined : defaultEdgeFrom(flow, tail)?.to;
    if (next !== undefined && !inAnyLane.has(next)) return next;
  }
  return undefined;
};

/**
 * A new service: a name, and a first step to fill in. Nothing leads to it yet — that is a
 * link, and links are drawn from a branch's dot onto the service, from the fork or from a
 * branch inside another service, when the business knows which answer takes a caller there.
 */
export const addService = (input: Flow, head: FlowNode, name: string): Flow => {
  const flow = withServiceTags(input);
  return { ...flow, nodes: [...flow.nodes, tagged(head, name)] };
};

/** A service name nothing is using yet: "new service", then "new service 2"… */
export const freshServiceName = (flow: Flow): string => {
  const a = analyse(flow);
  const taken = new Set(a.lanes.map((lane) => lane.label));
  if (a.fork !== undefined) for (const option of choiceOf(a.flow, a.fork)?.options ?? []) taken.add(option);
  if (!taken.has("new service")) return "new service";
  let at = 2;
  while (taken.has(`new service ${at}`)) at += 1;
  return `new service ${at}`;
};

/**
 * Lead a branch's arm into a service: the link, and — when the branch is the fork and the
 * arm has no answer yet — the service's name as the answer, added to the choice the fork
 * reads so the model may record it. From a branch inside a service the name is only a
 * starting guess at the answer, and is there to be edited.
 */
export const linkToService = (input: Flow, edge: FlowEdge, lane: Lane): Flow => {
  const flow = withServiceTags(input);
  if (lane.head === undefined || lane.ids.length === 0) return input;
  const a = analyse(flow);
  const unnamed = edge.when !== undefined && "equals" in edge.when && edge.when.equals === "";
  const link: FlowEdge = unnamed ? { ...edge, to: lane.head, when: { equals: lane.label } } : { ...edge, to: lane.head };
  const nodes =
    unnamed && a.fork !== undefined && edge.from === a.fork.id
      ? flow.nodes.map((node) => {
          if (node.kind !== "collect" || node.field === undefined || node.field.key !== a.fork?.on) return node;
          if (node.field.type !== "choice" || node.field.options.includes(lane.label)) return node;
          return { ...node, field: { ...node.field, options: [...node.field.options, lane.label] } };
        })
      : flow.nodes;
  return { ...flow, nodes, edges: [...flow.edges, link] };
};

/* ------------------------------------------------------------------ moving things */

/**
 * Whether a step can be picked up and put down somewhere else on the path.
 *
 * Not the start, which is where every call begins. Not a fork: it has several ways out and
 * "put it after that step" does not say which of them the path continues by, so the branches
 * would have to be re-drawn by hand — moving the whole service is the operation that means
 * something there, and that is done by moving its lane.
 */
export const movable = (node: FlowNode): boolean => node.kind !== "start" && node.kind !== "decide";

/**
 * Take a step off the path, closing the gap it leaves.
 *
 * Whatever led to the step now leads to what the step led to, so the call skips it as if it
 * had never been there. A step that ended the path leaves what led to it leading nowhere,
 * which the drawing then shows. Its own side branches — a "gave up" to a transfer, say — go
 * with it. The step itself stays in the graph: this is half of a move, and the other half
 * puts it back somewhere.
 */
export const detach = (flow: Flow, id: string): Flow => {
  const out = defaultEdgeFrom(flow, id);
  const edges = flow.edges
    .filter((edge) => edge !== out)
    .flatMap((edge) => (edge.to !== id ? [edge] : out === undefined ? [] : [{ ...edge, to: out.to }]));
  return { ...flow, edges };
};

/**
 * Remove a step, closing the gap it leaves — the way taking a card out of a list works.
 *
 * Whatever led to the step leads to what it led to. A fork leads on by its "anything else":
 * the one way out every caller can take, so the call still goes somewhere; its named arms go
 * with it, and the services they led to stay, unattached, for the operator to lead something
 * to again. The start cannot be removed: every call begins there.
 */
export const removeStep = (input: Flow, id: string): Flow => {
  const flow = withServiceTags(input);
  const node = byId(flow, id);
  if (node === undefined || node.kind === "start") return input;
  const onward = node.kind === "decide" ? flow.edges.find((edge) => edge.from === id && edge.otherwise === true)?.to : defaultEdgeFrom(flow, id)?.to;
  const edges = flow.edges
    .filter((edge) => edge.from !== id)
    .flatMap((edge) => (edge.to !== id ? [edge] : onward === undefined ? [] : [{ ...edge, to: onward }]));
  return { ...flow, nodes: flow.nodes.filter((n) => n.id !== id), edges };
};

/**
 * Put a new step on a link: what the link led to, the new step now leads to, and the link
 * leads to the new step. The step joins the service the link arrives in — a step put on a
 * fork's arm is the first step of that service — or, arriving nowhere in particular, the
 * service it left.
 */
export const insertOn = (input: Flow, link: FlowEdge, fresh: FlowNode): Flow => {
  const flow = withServiceTags(input);
  const at = flow.edges.find((edge) => edge === link) ?? flow.edges.find((edge) => edge.from === link.from && edge.to === link.to && edge.port === link.port && JSON.stringify(edge.when) === JSON.stringify(link.when) && edge.otherwise === link.otherwise);
  if (at === undefined) return input;
  const ends = fresh.kind === "transfer" || fresh.kind === "hangup";
  const service = serviceOf(byId(flow, at.to) ?? fresh) ?? serviceOf(byId(flow, at.from) ?? fresh);
  const placed = tagged(fresh, service);
  const onward: FlowEdge[] = ends ? [] : fresh.kind === "decide" ? [{ from: placed.id, to: at.to, otherwise: true }] : [{ from: placed.id, to: at.to }];
  return { ...flow, nodes: [...flow.nodes, placed], edges: [...flow.edges.map((edge) => (edge === at ? { ...edge, to: placed.id } : edge)), ...onward] };
};

/** The graph without one step in it, for putting the step back somewhere else. */
const lifted = (flow: Flow, id: string): { readonly node: FlowNode; readonly rest: Flow } | undefined => {
  const node = byId(flow, id);
  if (node === undefined || !movable(node)) return undefined;
  const rest = detach(flow, id);
  return { node, rest: { ...rest, nodes: rest.nodes.filter((n) => n.id !== id) } };
};

/** Put a step that is already on the drawing right after another, in that step's service. */
export const moveAfter = (input: Flow, id: string, anchor: string): Flow => {
  const flow = withServiceTags(input);
  if (id === anchor) return input;
  const moved = lifted(flow, id);
  if (moved === undefined || byId(flow, anchor) === undefined) return input;
  return insertAfter(moved.rest, anchor, moved.node);
};

/** Put a step that is already on the drawing right before another — at the top of a service, say. */
export const moveBefore = (input: Flow, id: string, anchor: string): Flow => {
  const flow = withServiceTags(input);
  if (id === anchor) return input;
  const moved = lifted(flow, id);
  if (moved === undefined || byId(flow, anchor) === undefined) return input;
  return insertBefore(moved.rest, anchor, moved.node);
};

/**
 * Put a step that is already on the drawing at the end of a lane.
 *
 * The lane is looked up again once the step is out, because taking a lane's only step away
 * leaves the lane with nothing — the label is what survives, and a lane a branch still leads
 * to is drawn empty and takes the step back onto the branch.
 */
export const moveToLane = (input: Flow, id: string, lane: Lane): Flow => {
  const flow = withServiceTags(input);
  const moved = lifted(flow, id);
  if (moved === undefined) return input;
  const after = laneGroups(moved.rest);
  const target =
    after.find((one) => one.id === lane.id) ??
    after.find((one) => one.label === lane.label) ??
    (lane.id === "opening" ? undefined : { id: `svc:${lane.label}`, label: lane.label, ids: [] });
  if (target === undefined) return input;
  return appendToLane(moved.rest, target, moved.node);
};

/** Make a step that is already on the drawing the first step of a new service. */
export const moveToNewService = (input: Flow, id: string, name: string): Flow => {
  const flow = withServiceTags(input);
  const moved = lifted(flow, id);
  if (moved === undefined) return input;
  return addService(moved.rest, moved.node, name);
};

/**
 * Draw one service before another, or last when `before` is null.
 *
 * The lanes are drawn in the order their names first appear among the steps, so this moves
 * the service's steps in the list and changes nothing about the call.
 */
export const reorderService = (input: Flow, lane: Lane, before: Lane | null): Flow => {
  const flow = withServiceTags(input);
  if (lane.ids.length === 0) return input;
  const moving = new Set(lane.ids);
  const rest = flow.nodes.filter((node) => !moving.has(node.id));
  const taken = flow.nodes.filter((node) => moving.has(node.id));
  const firstOf = before === null ? -1 : rest.findIndex((node) => before.ids.includes(node.id));
  const at = firstOf < 0 ? rest.length : firstOf;
  return { ...flow, nodes: [...rest.slice(0, at), ...taken, ...rest.slice(at)] };
};

/**
 * Remove a service: every step in it, the links to and from them, its option on the choice
 * the fork reads, and its branch from the fork.
 *
 * The catch-all is the one branch a fork cannot be without, so removing that service keeps
 * its branch and leads it straight to wherever the service led — the shared close, usually —
 * which is what "anything else" then means: nothing to ask, on to the goodbye. A service that
 * ended the call itself has nowhere to lead on to, and the branch is dropped; the validator
 * then says the fork needs an "anything else", which is true and is the operator's to wire.
 */
export const removeService = (input: Flow, lane: Lane): Flow => {
  const flow = withServiceTags(input);
  if (lane.id === "opening") return input;
  const branch = branchEdgeOf(flow, lane);
  const fork = lane.fork === undefined ? undefined : byId(flow, lane.fork);
  const gone = new Set(lane.ids);
  const tail = laneTail(flow, lane);
  const onward = tail === undefined ? undefined : defaultEdgeFrom(flow, tail)?.to;
  const rejoin = onward !== undefined && !gone.has(onward) ? onward : undefined;
  /* Whatever led into the service from outside it — a branch inside another service that
     jumped here, or the catch-all — leads on to wherever the service led, so no arm loses
     its answer for the service it pointed at being gone. The fork's named branch is the
     service's own and goes with it, option and all; with nowhere to lead on to, a link is
     dropped and the validator says what is now missing. */
  const edges = flow.edges.flatMap((edge) => {
    if (edge === branch) return lane.catchAll === true && rejoin !== undefined ? [{ ...edge, to: rejoin }] : [];
    if (gone.has(edge.from)) return [];
    if (gone.has(edge.to)) return rejoin === undefined ? [] : [{ ...edge, to: rejoin }];
    return [edge];
  });
  return {
    ...flow,
    nodes: flow.nodes
      .filter((node) => !gone.has(node.id))
      .map((node) => {
        if (fork === undefined || node.kind !== "collect" || node.field === undefined || node.field.key !== fork.on || node.field.type !== "choice") return node;
        return { ...node, field: { ...node.field, options: node.field.options.filter((option) => option !== lane.label) } };
      }),
    edges,
  };
};

/**
 * Rename a service: the name on its steps, the answer on its branch, and the option on the
 * choice the fork reads, together — they are the same word in three places. The catch-all's
 * name is the one option left uncovered and renaming it renames that option; with no such
 * option it has no name to change. A name another service has is not available.
 */
export const renameService = (input: Flow, lane: Lane, name: string): Flow => {
  const flow = withServiceTags(input);
  const trimmed = name.trim();
  if (lane.id === "opening" || trimmed === "" || trimmed === lane.label) return input;
  const a = analyse(flow);
  const field = a.fork === undefined ? undefined : choiceOf(flow, a.fork);
  const taken =
    a.lanes.some((other) => other.label === trimmed) ||
    (a.fork !== undefined && flow.edges.some((edge) => edge.from === a.fork?.id && edge.when !== undefined && "equals" in edge.when && edge.when.equals === trimmed)) ||
    (field?.options ?? []).includes(trimmed);
  if (taken) return input;
  if (lane.catchAll === true && (field === undefined || !field.options.includes(lane.label))) return input;
  const branch = branchEdgeOf(flow, lane);
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const renamed = serviceOf(node) === lane.label ? tagged(node, trimmed) : node;
      if (a.fork === undefined || renamed.kind !== "collect" || renamed.field === undefined || renamed.field.key !== a.fork.on || renamed.field.type !== "choice") return renamed;
      return { ...renamed, field: { ...renamed.field, options: renamed.field.options.map((option) => (option === lane.label ? trimmed : option)) } };
    }),
    edges: flow.edges.map((edge) => (edge === branch && lane.catchAll !== true ? { ...edge, when: { equals: trimmed } } : edge)),
  };
};
