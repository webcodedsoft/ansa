import type { Flow, FlowNode } from "./flow.schema";

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
export const tidied = (flow: Flow): Flow => {
  const depth = depths(flow);
  const fork = firstFork(flow, depth);
  const forkDepth = fork === undefined ? Infinity : (depth.get(fork.id) ?? Infinity);

  const unreached = Math.max(0, ...[...depth.values()].map((value) => value + 1));
  const perRow = new Map<number, number>();
  for (const node of flow.nodes) {
    const row = depth.get(node.id) ?? unreached;
    perRow.set(row, (perRow.get(row) ?? 0) + 1);
  }
  const widest = Math.max(1, ...perRow.values());
  const filled = new Map<number, number>();

  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const row = depth.get(node.id) ?? unreached;
      const across = filled.get(row) ?? 0;
      filled.set(row, across + 1);
      const inRow = perRow.get(row) ?? 1;
      // Everything below the fork drops by the lane gap, so the fan and the lane headers fit.
      const y = TOP + row * ROW + (row > forkDepth ? LANE_GAP : 0);
      return { ...node, x: LEFT + ((widest - inRow) / 2 + across) * COLUMN, y };
    }),
  };
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
  /** The branch head this lane belongs to, or `"opening"` for the shared questions. */
  readonly id: string;
  readonly label: string;
  readonly ids: readonly string[];
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
  for (const branch of branchHeads(flow, fork)) {
    lanes.push({ id: branch.to, label: branch.label, ids: [branch.to, ...onlyReachableThrough(flow, branch.to)] });
  }
  return lanes;
};

/** The branch heads: every step a `decide` leads to, labelled by the answer that gets there. */
export const branchHeads = (
  flow: Flow,
  decide: FlowNode,
): readonly { readonly to: string; readonly label: string }[] =>
  flow.edges
    .filter((edge) => edge.from === decide.id)
    .map((edge) => ({
      to: edge.to,
      label:
        edge.otherwise === true
          ? "anything else"
          : edge.when !== undefined && "equals" in edge.when
            ? edge.when.equals
            : (edge.port ?? "next"),
    }));
