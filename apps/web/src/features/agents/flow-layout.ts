import type { Flow, FlowEdge, FlowNode } from "./flow.schema";

/**
 * Where the steps sit, and which of them are folded away.
 *
 * Both are derived, and that is the point. Positions used to be authored — you dragged a
 * card and the coordinates were saved — which meant every graph carried a layout somebody
 * had to maintain, a "Tidy up" button to repair it, and the standing possibility of a flow
 * that was correct and unreadable. Deriving the layout from the graph removes all three:
 * there is nothing to arrange, so nothing can be untidy.
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

/**
 * Rows by distance from the answer, columns by arrival within the row.
 *
 * A fork reads as a fork rather than a staircase because the steps it leads to share a row.
 * Anything the walk never reaches goes in a row of its own below the end — which is also the
 * clearest way to see that a step is unreachable, without drawing a report about it.
 */
/**
 * The columns: which lane each step is in, how wide each lane is, and where each lane starts.
 *
 * Columns follow lanes, not rows. Centring every row on its own put the second row of three
 * lanes in the gaps between the first — each lane's cards wandering towards the middle as the
 * lanes below it got fewer — and a lane drawn round that overlapped its neighbour. So each
 * service owns a run of columns as wide as its widest row, the lanes sit side by side, and
 * everything outside a lane — the opening, the rejoin, the unreachable — is centred across
 * all of them. A service with no steps in it yet still owns a column, so it has somewhere
 * to be drawn and something to drop a step onto.
 */
const columns = (flow: Flow) => {
  const depth = depths(flow);
  const fork = firstFork(flow, depth);
  const forkDepth = fork === undefined ? Infinity : (depth.get(fork.id) ?? Infinity);
  const unreached = Math.max(0, ...[...depth.values()].map((value) => value + 1));
  const rowOf = (id: string): number => depth.get(id) ?? unreached;

  const lanes = fork === undefined ? [] : laneGroups(flow);
  const laneOf = new Map<string, number>();
  lanes.forEach((lane, at) => {
    if (lane.id === "opening") return;
    for (const id of lane.ids) laneOf.set(id, at);
  });

  /** Rows inside one lane (or the shared area, keyed -1): how many steps share each row. */
  const rows = new Map<number, Map<number, number>>();
  const count = (lane: number, row: number): number => {
    const inLane = rows.get(lane) ?? new Map<number, number>();
    const seen = (inLane.get(row) ?? 0) + 1;
    inLane.set(row, seen);
    rows.set(lane, inLane);
    return seen - 1;
  };
  const perRow = new Map<string, number>();
  for (const node of flow.nodes) perRow.set(node.id, count(laneOf.get(node.id) ?? -1, rowOf(node.id)));

  const widthOf = (lane: number): number => Math.max(1, ...(rows.get(lane)?.values() ?? [1]));
  const laneLeft: number[] = [];
  let total = 0;
  lanes.forEach((lane, at) => {
    laneLeft[at] = total;
    if (lane.id !== "opening") total += widthOf(at);
  });
  const totalCols = Math.max(total, widthOf(-1));
  /** The deepest row any lane reaches; everything shared below it drops by the rejoin gap. */
  const laneFloor = Math.max(forkDepth, ...flow.nodes.filter((node) => laneOf.has(node.id)).map((node) => rowOf(node.id)));

  return { lanes, laneOf, rows, perRow, widthOf, laneLeft, totalCols, rowOf, forkDepth, laneFloor };
};

export const tidied = (flow: Flow): Flow => {
  const { laneOf, rows, perRow, widthOf, laneLeft, totalCols, rowOf, forkDepth, laneFloor } = columns(flow);
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const row = rowOf(node.id);
      const across = perRow.get(node.id) ?? 0;
      const lane = laneOf.get(node.id);
      const inRow = rows.get(lane ?? -1)?.get(row) ?? 1;
      const col =
        lane === undefined
          ? (totalCols - inRow) / 2 + across
          : (laneLeft[lane] ?? 0) + (widthOf(lane) - inRow) / 2 + across;
      // Everything below the fork drops by the lane gap, so the fan and the lane headers fit;
      // everything below the lanes drops again, so the links that rejoin have a gap to run in.
      const y = TOP + row * ROW + (row > forkDepth ? LANE_GAP : 0) + (row > laneFloor && !laneOf.has(node.id) ? REJOIN_GAP : 0);
      return { ...node, x: LEFT + col * COLUMN, y };
    }),
  };
};

/**
 * Where each service's column starts and how wide it is, in pixels, with the row its first
 * step sits on. What the canvas draws a lane from when the lane has no cards to measure —
 * a service just added, or one whose only step was dragged elsewhere.
 */
export const laneFrames = (flow: Flow): readonly { readonly id: string; readonly left: number; readonly width: number; readonly top: number }[] => {
  const { lanes, widthOf, laneLeft, forkDepth } = columns(flow);
  const top = TOP + (forkDepth + 1) * ROW + LANE_GAP;
  return lanes
    .map((lane, at) => ({ id: lane.id, left: LEFT + (laneLeft[at] ?? 0) * COLUMN, width: widthOf(at) * COLUMN, top }))
    .filter((frame) => frame.id !== "opening");
};

/**
 * Whether two graphs have the same steps and the same links.
 *
 * The test for "re-lay this out". Editing the words in a step must not move anything — a
 * card that jumps while you are typing in it is worse than an untidy one — so the layout
 * runs when the shape changes and not when the content does.
 */
export const sameShape = (a: Flow, b: Flow): boolean => {
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
  const ids = new Set(a.nodes.map((node) => node.id));
  if (b.nodes.some((node) => !ids.has(node.id))) return false;
  const links = new Set(a.edges.map((edge) => `${edge.from} ${edge.to} ${edge.port ?? ""}`));
  return b.edges.every((edge) => links.has(`${edge.from} ${edge.to} ${edge.port ?? ""}`));
};

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
 * The steps that exist only because of `head` — the ones a call can reach no other way.
 *
 * Folding a branch away has to fold that branch and nothing else. A shared closing line two
 * other branches also reach is not part of this one, and hiding it because it happens to sit
 * below would make the rest of the call vanish. So: walk the graph with `head` removed, and
 * whatever can no longer be reached belonged to it.
 */
export const onlyReachableThrough = (flow: Flow, head: string): ReadonlySet<string> =>
  reachableOnlyVia(flow, new Set([head]));

/**
 * Everything folded away by the collapsed branches — worked out together, not one at a time.
 *
 * Folding two arms that share a closing line has to take the closing line with them, and no
 * union of the arms taken separately ever will: while either arm is still open the close is
 * reachable, so neither considers it its own. Removing all the heads at once is the only
 * question that has the right answer.
 */
export const foldedAway = (flow: Flow, collapsed: Iterable<string>): ReadonlySet<string> => {
  const heads = new Set<string>();
  for (const head of collapsed) if (flow.nodes.some((node) => node.id === head)) heads.add(head);
  if (heads.size === 0) return new Set<string>();
  /* The head goes too. Leaving it on screen while its own steps vanish is the worst of both
     — a chip that says "3 folded" beside one of the three still sitting there. Folding a
     branch away means the branch is away, and the chip on the fork is what stands in for it. */
  const gone = new Set(heads);
  for (const id of reachableOnlyVia(flow, heads)) gone.add(id);
  return gone;
};

/** What becomes unreachable once every one of `heads` is taken out, the heads excluded. */
const reachableOnlyVia = (flow: Flow, heads: ReadonlySet<string>): ReadonlySet<string> => {
  const whole = reachableWithout(flow, new Set());
  const without = reachableWithout(flow, heads);
  const only = new Set<string>();
  for (const id of whole) if (!heads.has(id) && !without.has(id)) only.add(id);
  return only;
};

/** How many steps a folded branch stands in for, counting its own head. */
export const foldedCount = (flow: Flow, head: string): number => onlyReachableThrough(flow, head).size + 1;

/**
 * One labelled group of steps on the canvas — the shared opening, then a lane per service.
 *
 * A six-service front desk drawn as twenty-four cards is a wall, and the only way to tell
 * which service you are looking at is to trace links upward with your eyes. The graph already
 * knows the answer: everything before the first fork is asked of everybody, and everything
 * only one branch can reach belongs to that branch. Naming those groups on the drawing costs
 * nothing and is the difference between a diagram and a business.
 */
export interface Lane {
  /**
   * The branch head this lane belongs to, or `"opening"` for the shared questions. A lane
   * whose branch points straight at a shared step — every step it had has been moved away —
   * owns no head, and is keyed by the answer that reaches it instead.
   */
  readonly id: string;
  readonly label: string;
  /** The steps only this lane reaches. Empty for a service with nothing in it yet. */
  readonly ids: readonly string[];
  /** The fork this lane is a branch of, and the step the branch points at. Absent on the opening. */
  readonly fork?: string;
  readonly head?: string;
  /**
   * The branch the call takes when the answer is none of the named ones. Labelled by the one
   * option the named branches leave uncovered when there is exactly one — a template's
   * "rent or buy" draws buy as the catch-all, and the lane should still say buy — and
   * "anything else" otherwise.
   */
  readonly catchAll?: true;
}

/**
 * The lanes, or none at all.
 *
 * None when the call never forks: a straight line has one lane, and drawing a box round the
 * whole drawing to say so is a label that tells nobody anything. Only the *first* fork makes
 * lanes — a fork inside a service is drawn inside that service's lane, which is where it
 * belongs, rather than splitting the top level into something the business does not have.
 */
/** The shallowest reachable `decide`: where the call first splits into services. */
const firstFork = (flow: Flow, depth: ReadonlyMap<string, number>): FlowNode | undefined =>
  flow.nodes
    .filter((node) => node.kind === "decide" && depth.has(node.id))
    .sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0))[0];

export const laneGroups = (flow: Flow): readonly Lane[] => {
  const depth = depths(flow);
  const fork = firstFork(flow, depth);
  if (fork === undefined) return [];

  const forkDepth = depth.get(fork.id) ?? 0;
  const opening = flow.nodes
    .filter((node) => (depth.get(node.id) ?? Infinity) <= forkDepth)
    .map((node) => node.id);

  const lanes: Lane[] = [{ id: "opening", label: "everyone gets this", ids: opening }];
  const named = new Set(flow.edges.filter((edge) => edge.from === fork.id && edge.when !== undefined && "equals" in edge.when).map((edge) => (edge.when as { equals: string }).equals));
  const uncovered = (choiceOf(flow, fork)?.options ?? []).filter((option) => !named.has(option));
  for (const branch of branchHeads(flow, fork)) {
    /* A branch that leads straight to a step other branches also reach — the close, say —
       has no steps of its own. The lane still exists, because the service does: the option
       is on the choice and the fork takes it. It is drawn empty, and keyed by its answer
       since its head is somebody else's. */
    const owned = !reachableWithout({ ...flow, edges: flow.edges.filter((edge) => edge !== branch.edge) }, new Set()).has(branch.to);
    const catchAll = branch.edge.otherwise === true;
    const label = catchAll && uncovered.length === 1 ? (uncovered[0] ?? branch.label) : branch.label;
    lanes.push({
      id: owned ? branch.to : `via:${label}`,
      label,
      ids: owned ? [branch.to, ...onlyReachableThrough(flow, branch.to)] : [],
      fork: fork.id,
      head: branch.to,
      ...(catchAll ? { catchAll: true as const } : {}),
    });
  }
  return lanes;
};

/** The choice a fork reads, when it is one: the `collect` step whose field the fork is on. */
const choiceOf = (flow: Flow, fork: FlowNode) => {
  const field = flow.nodes.find((n) => n.kind === "collect" && n.field !== undefined && n.field.key === fork.on)?.field;
  return field !== undefined && field.type === "choice" ? field : undefined;
};

/** The branch heads: every step a `decide` leads to, labelled by the answer that gets there. */
export const branchHeads = (
  flow: Flow,
  decide: FlowNode,
): readonly { readonly to: string; readonly label: string; readonly edge: FlowEdge }[] =>
  flow.edges
    .filter((edge) => edge.from === decide.id)
    .map((edge) => ({
      to: edge.to,
      edge,
      label:
        edge.otherwise === true
          ? "anything else"
          : edge.when !== undefined && "equals" in edge.when
            ? edge.when.equals
            : (edge.port ?? "next"),
    }));

/* ------------------------------------------------------------------ growing it */

/**
 * The edge a step leaves by when nothing else is said: the first port's, which is the one
 * a link with no port name belongs to. A `decide` has no default; every way out is named.
 */
const defaultEdgeFrom = (flow: Flow, id: string): FlowEdge | undefined => {
  const node = flow.nodes.find((n) => n.id === id);
  if (node === undefined || node.kind === "decide") return undefined;
  return flow.edges.find((edge) => edge.from === id && edge.when === undefined && edge.otherwise === undefined && (edge.port === undefined || edge.port === FIRST_PORT[node.kind]));
};

/** The name of each kind's first port, where it has one. Mirrors `portsOf` on the canvas. */
const FIRST_PORT: Partial<Record<FlowNode["kind"], string>> = { collect: "got", confirm: "yes", tool: "ok" };

/**
 * Put a new step on the path right after `anchor`.
 *
 * Whatever the anchor led to, the new step now leads to instead — so a question dropped
 * between two others is asked between them, not left floating for somebody to wire. A step
 * that ends the call (a transfer, a hang-up) leads nowhere, and whatever used to follow is
 * cut loose: that is what dropping an ending there means, and the drawing shows the rest as
 * unreachable rather than pretending. A new branch takes over the old link as its catch-all,
 * which is the one way out a branch must have before it can be published.
 */
export const insertAfter = (flow: Flow, anchor: string, fresh: FlowNode): Flow => {
  const out = defaultEdgeFrom(flow, anchor);
  const ends = fresh.kind === "transfer" || fresh.kind === "hangup";
  const edges = flow.edges.filter((edge) => edge !== out);
  const toAnchor: FlowEdge = out === undefined ? { from: anchor, to: fresh.id } : { ...out, to: fresh.id };
  const onward: FlowEdge[] =
    out === undefined || ends
      ? []
      : fresh.kind === "decide"
        ? [{ from: fresh.id, to: out.to, otherwise: true }]
        : [{ from: fresh.id, to: out.to }];
  return { ...flow, nodes: [...flow.nodes, fresh], edges: [...edges, toAnchor, ...onward] };
};

/**
 * Put a new step on the path right before `anchor`: everything that led to the anchor now
 * leads to the new step, and the new step leads to the anchor. Used for the opening lane,
 * whose last step is the fork — a question dropped there is asked before the call splits.
 */
export const insertBefore = (flow: Flow, anchor: string, fresh: FlowNode): Flow => {
  if (fresh.kind === "transfer" || fresh.kind === "hangup") return insertAfter(flow, anchor, fresh);
  // Nothing goes before the answer; "before the start" is the first thing after it.
  if (flow.nodes.find((n) => n.id === anchor)?.kind === "start") return insertAfter(flow, anchor, fresh);
  const edges = flow.edges.map((edge) => (edge.to === anchor ? { ...edge, to: fresh.id } : edge));
  const onward: FlowEdge = fresh.kind === "decide" ? { from: fresh.id, to: anchor, otherwise: true } : { from: fresh.id, to: anchor };
  return { ...flow, nodes: [...flow.nodes, fresh], edges: [...edges, onward] };
};

/** The last step of a lane, following each step's default way out while it stays in the lane. */
export const laneTail = (flow: Flow, lane: Lane): string | undefined => {
  const inLane = new Set(lane.ids);
  if (lane.id === "opening") return undefined;
  let at: string = lane.id;
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
 * means after the service's last step, before the path rejoins.
 */
export const appendToLane = (flow: Flow, lane: Lane, fresh: FlowNode): Flow => {
  if (lane.id === "opening") {
    const fork = lane.ids.find((id) => flow.nodes.find((n) => n.id === id)?.kind === "decide");
    return fork === undefined ? { ...flow, nodes: [...flow.nodes, fresh] } : insertBefore(flow, fork, fresh);
  }
  /* An empty service: its branch points past it at a shared step. The new step goes on the
     branch — the fork leads to it, and it leads on to where the branch was going. */
  if (lane.ids.length === 0) {
    const branch = branchEdgeOf(flow, lane);
    if (branch === undefined) return { ...flow, nodes: [...flow.nodes, fresh] };
    const ends = fresh.kind === "transfer" || fresh.kind === "hangup";
    const onward: FlowEdge[] = ends ? [] : fresh.kind === "decide" ? [{ from: fresh.id, to: branch.to, otherwise: true }] : [{ from: fresh.id, to: branch.to }];
    return { ...flow, nodes: [...flow.nodes, fresh], edges: [...flow.edges.map((edge) => (edge === branch ? { ...edge, to: fresh.id } : edge)), ...onward] };
  }
  const tail = laneTail(flow, lane);
  return tail === undefined ? { ...flow, nodes: [...flow.nodes, fresh] } : insertAfter(flow, tail, fresh);
};

/** The edge from the fork that this lane is: the one carrying the lane's answer. */
export const branchEdgeOf = (flow: Flow, lane: Lane): FlowEdge | undefined =>
  flow.edges.find(
    (edge) =>
      edge.from === lane.fork &&
      edge.to === lane.head &&
      (lane.catchAll === true ? edge.otherwise === true : edge.when !== undefined && "equals" in edge.when && edge.when.equals === lane.label),
  );

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
 * A new service: another answer to the question the call splits on, with a first step of
 * its own that rejoins where the others do.
 *
 * Three things change together, because a service is three things at once. The choice the
 * fork reads gains an option, so the model may record the answer; the fork gains a branch
 * for that option, so the director takes it; and a first step is drawn on the branch and
 * wired to the rejoin, so the lane exists on the canvas and the call has somewhere to go.
 * Any one of those without the others is a service the validator refuses.
 */
export const addService = (flow: Flow, lanes: readonly Lane[], head: FlowNode, name: string): Flow => {
  const opening = lanes.find((lane) => lane.id === "opening");
  const fork = opening?.ids.map((id) => flow.nodes.find((n) => n.id === id)).find((n) => n?.kind === "decide");
  if (fork === undefined) return flow;

  const nodes = flow.nodes.map((node) => {
    if (node.kind !== "collect" || node.field === undefined || node.field.key !== fork.on) return node;
    if (node.field.type !== "choice" || node.field.options.includes(name)) return node;
    return { ...node, field: { ...node.field, options: [...node.field.options, name] } };
  });
  const rejoin = rejoinPoint(flow, lanes);
  /* The new branch goes last, so the new lane appears where the "add a service" box was and
     the box moves along. The order of a fork's branches is only the order they are drawn in:
     the director tries every named answer before the catch-all whichever comes first. */
  const edges: FlowEdge[] = [...flow.edges, { from: fork.id, to: head.id, when: { equals: name } }];
  if (rejoin !== undefined) edges.push({ from: head.id, to: rejoin });
  return { ...flow, nodes: [...nodes, head], edges };
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

/** The graph without one step in it, for putting the step back somewhere else. */
const lifted = (flow: Flow, id: string): { readonly node: FlowNode; readonly rest: Flow } | undefined => {
  const node = flow.nodes.find((n) => n.id === id);
  if (node === undefined || !movable(node)) return undefined;
  const rest = detach(flow, id);
  return { node, rest: { ...rest, nodes: rest.nodes.filter((n) => n.id !== id) } };
};

/** Put a step that is already on the drawing right after another, the way a new one goes. */
export const moveAfter = (flow: Flow, id: string, anchor: string): Flow => {
  if (id === anchor) return flow;
  const moved = lifted(flow, id);
  if (moved === undefined || !flow.nodes.some((n) => n.id === anchor)) return flow;
  return insertAfter(moved.rest, anchor, moved.node);
};

/** Put a step that is already on the drawing right before another — at the top of a service, say. */
export const moveBefore = (flow: Flow, id: string, anchor: string): Flow => {
  if (id === anchor) return flow;
  const moved = lifted(flow, id);
  if (moved === undefined || !flow.nodes.some((n) => n.id === anchor)) return flow;
  return insertBefore(moved.rest, anchor, moved.node);
};

/**
 * Put a step that is already on the drawing at the end of a lane.
 *
 * The lane is looked up again once the step is out, because taking a lane's first step away
 * gives the lane a new head and so a new id — the label is what survives.
 */
export const moveToLane = (flow: Flow, id: string, lane: Lane): Flow => {
  const moved = lifted(flow, id);
  if (moved === undefined) return flow;
  const after = laneGroups(moved.rest);
  const target = after.find((one) => one.id === lane.id) ?? after.find((one) => one.label === lane.label);
  if (target === undefined) return flow;
  return appendToLane(moved.rest, target, moved.node);
};

/** Make a step that is already on the drawing the first step of a new service. */
export const moveToNewService = (flow: Flow, id: string, name: string): Flow => {
  const moved = lifted(flow, id);
  if (moved === undefined) return flow;
  return addService(moved.rest, laneGroups(moved.rest), moved.node, name);
};

/**
 * Draw one service before another, or last when `before` is null.
 *
 * The lanes are drawn in the order of the fork's branches, so this is a reordering of edges
 * and changes nothing about the call: the director matches on the answer, not the position.
 */
export const reorderService = (flow: Flow, lane: Lane, before: Lane | null): Flow => {
  const moving = branchEdgeOf(flow, lane);
  if (moving === undefined) return flow;
  const rest = flow.edges.filter((edge) => edge !== moving);
  const target = before === null ? undefined : branchEdgeOf(flow, before);
  const at = target === undefined ? rest.findLastIndex((edge) => edge.from === lane.fork) + 1 : rest.indexOf(target);
  return { ...flow, edges: [...rest.slice(0, at), moving, ...rest.slice(at)] };
};

/**
 * Remove a service: its branch, its option on the choice the fork reads, and every step only
 * it reaches — the three things `addService` added. Not the catch-all: a fork without one
 * cannot publish, and "anything else" is not something a business is without.
 */
export const removeService = (flow: Flow, lane: Lane): Flow => {
  const branch = branchEdgeOf(flow, lane);
  if (branch === undefined || branch.otherwise === true) return flow;
  const fork = flow.nodes.find((n) => n.id === lane.fork);
  const gone = new Set(lane.ids);
  return {
    ...flow,
    nodes: flow.nodes
      .filter((node) => !gone.has(node.id))
      .map((node) => {
        if (fork === undefined || node.kind !== "collect" || node.field === undefined || node.field.key !== fork.on || node.field.type !== "choice") return node;
        return { ...node, field: { ...node.field, options: node.field.options.filter((option) => option !== lane.label) } };
      }),
    edges: flow.edges.filter((edge) => edge !== branch && !gone.has(edge.from) && !gone.has(edge.to)),
  };
};

/**
 * Rename a service: the answer on the branch, and the option on the choice the fork reads,
 * together — they are the same word in two places, and the validator refuses them apart.
 * The catch-all has no name to change, and a name another service has is not available.
 */
export const renameService = (flow: Flow, lane: Lane, name: string): Flow => {
  const trimmed = name.trim();
  const branch = branchEdgeOf(flow, lane);
  if (branch === undefined || trimmed === "" || trimmed === lane.label) return flow;
  const fork = flow.nodes.find((n) => n.id === lane.fork);
  if (fork === undefined) return flow;
  const field = choiceOf(flow, fork);
  const taken =
    flow.edges.some((edge) => edge.from === lane.fork && edge.when !== undefined && "equals" in edge.when && edge.when.equals === trimmed) ||
    (field?.options ?? []).includes(trimmed);
  if (taken) return flow;
  /* The catch-all has a name only when one option is left uncovered and it stands in for it;
     renaming it renames that option, and the branch — which matches nothing by name — is
     untouched. With no such option there is nothing to rename. */
  if (lane.catchAll === true && (field === undefined || !field.options.includes(lane.label))) return flow;
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      if (node.kind !== "collect" || node.field === undefined || node.field.key !== fork.on || node.field.type !== "choice") return node;
      return { ...node, field: { ...node.field, options: node.field.options.map((option) => (option === lane.label ? trimmed : option)) } };
    }),
    edges: lane.catchAll === true ? flow.edges : flow.edges.map((edge) => (edge === branch ? { ...edge, when: { equals: trimmed } } : edge)),
  };
};

/** A service name nothing at this fork is using yet: "new service", then "new service 2"… */
export const freshServiceName = (flow: Flow, lanes: readonly Lane[]): string => {
  const taken = new Set(lanes.map((lane) => lane.label));
  const opening = lanes.find((lane) => lane.id === "opening");
  const fork = opening?.ids.map((id) => flow.nodes.find((n) => n.id === id)).find((n) => n?.kind === "decide");
  const field = flow.nodes.find((n) => n.kind === "collect" && n.field?.key === fork?.on)?.field;
  for (const option of field?.options ?? []) taken.add(option);
  if (!taken.has("new service")) return "new service";
  let at = 2;
  while (taken.has(`new service ${at}`)) at += 1;
  return `new service ${at}`;
};
