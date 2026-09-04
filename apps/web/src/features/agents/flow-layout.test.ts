import type { Flow, FlowNode } from "./flow.schema";
import { describe, expect, it } from "vitest";

import { validateFlow } from "@ansa/shared/flow-validate";

import {
  addService, appendToLane, branchHeads, foldedAway, foldedCount, freshServiceName, insertAfter, laneGroups,
  onlyReachableThrough, rejoinPoint, ROW, sameShape, tidied, TOP,
} from "./flow-layout";

/**
 * The layout is no longer decoration.
 *
 * With positions derived rather than dragged, a bug here is not an untidy canvas — it is
 * steps drawn on top of each other, or a branch that folds away the rest of the call with
 * it. Both are tested against the shape every template actually has: a shared opening, a
 * fork into services, and one closing line the services meet again at.
 */

const node = (id: string, kind: FlowNode["kind"] = "collect"): FlowNode => ({ id, kind, x: 0, y: 0 });

/** start → ask → fork ⟨rent | buy⟩, both arms rejoining at one close, then the end. */
const forked = (): Flow => ({
  version: 1,
  nodes: [
    node("start", "start"),
    node("ask"),
    node("fork", "decide"),
    node("rent1"),
    node("rent2"),
    node("buy1"),
    node("close", "say"),
    node("end", "hangup"),
  ],
  edges: [
    { from: "start", to: "ask" },
    { from: "ask", to: "fork" },
    { from: "fork", to: "rent1", when: { equals: "rent" } },
    { from: "rent1", to: "rent2" },
    { from: "rent2", to: "close" },
    { from: "fork", to: "buy1", otherwise: true },
    { from: "buy1", to: "close" },
    { from: "close", to: "end" },
  ],
});

describe("laying the steps out", () => {
  it("puts the call down the page in the order it happens", () => {
    const laid = tidied(forked());
    const at = (id: string) => laid.nodes.find((n) => n.id === id);

    expect(at("start")?.y).toBe(TOP);
    expect(at("ask")?.y).toBe(TOP + ROW);
    expect(at("fork")?.y).toBe(TOP + 2 * ROW);
    // Both arms start on the same row, side by side, so a fork reads as a fork.
    expect(at("rent1")?.y).toBe(at("buy1")?.y);
    expect(at("rent1")?.x).not.toBe(at("buy1")?.x);
    // The close is below the deepest arm, not beside it.
    expect(at("close")?.y).toBeGreaterThan(at("rent2")?.y ?? 0);
  });

  it("never draws two steps in the same place", () => {
    const spots = tidied(forked()).nodes.map((n) => `${n.x},${n.y}`);
    expect(new Set(spots).size).toBe(spots.length);
  });

  it("puts a step nothing reaches below the end, where it reads as unreachable", () => {
    const orphaned: Flow = { ...forked(), nodes: [...forked().nodes, node("stray")] };
    const laid = tidied(orphaned);
    const stray = laid.nodes.find((n) => n.id === "stray");
    const end = laid.nodes.find((n) => n.id === "end");

    expect(stray?.y).toBeGreaterThan(end?.y ?? 0);
  });

  it("survives a graph with no start at all rather than throwing", () => {
    const loose: Flow = { version: 1, nodes: [node("a"), node("b")], edges: [] };
    expect(() => tidied(loose)).not.toThrow();
    expect(tidied(loose).nodes).toHaveLength(2);
  });
});

describe("deciding when to lay out again", () => {
  it("calls a graph the same when only the words changed", () => {
    const before = forked();
    const after: Flow = {
      ...before,
      nodes: before.nodes.map((n) => (n.id === "close" ? { ...n, text: "Somebody will call you back." } : n)),
    };
    // The point of the whole check: typing in a step must not move the drawing.
    expect(sameShape(before, after)).toBe(true);
  });

  it("calls it different when a step or a link is added or removed", () => {
    const before = forked();
    expect(sameShape(before, { ...before, nodes: [...before.nodes, node("extra")] })).toBe(false);
    expect(sameShape(before, { ...before, edges: before.edges.slice(1) })).toBe(false);
    expect(sameShape(before, { ...before, edges: [...before.edges.slice(1), { from: "start", to: "fork" }] })).toBe(false);
  });
});

describe("folding a branch away", () => {
  it("takes the branch's own steps and nothing else", () => {
    expect([...onlyReachableThrough(forked(), "rent1")].sort()).toEqual(["rent2"]);
  });

  /* The one that matters. Both arms end at the same closing line, so folding one arm must
     leave the close — and therefore the end of the call — on screen. Getting this wrong
     makes the rest of the call disappear when somebody folds a branch they are done with. */
  it("takes the branch itself and leaves an ending another branch also reaches", () => {
    const hidden = foldedAway(forked(), ["rent1"]);

    // The head goes with its own steps; the chip on the fork stands in for the lot.
    expect(hidden.has("rent1")).toBe(true);
    expect(hidden.has("rent2")).toBe(true);
    // …and the shared close, and the end it leads to, stay on screen.
    expect(hidden.has("close")).toBe(false);
    expect(hidden.has("end")).toBe(false);
    expect(hidden.has("buy1")).toBe(false);
  });

  it("takes the shared ending only once every branch to it is folded", () => {
    const hidden = foldedAway(forked(), ["rent1", "buy1"]);

    expect(hidden.has("rent1")).toBe(true);
    expect(hidden.has("buy1")).toBe(true);
    expect(hidden.has("rent2")).toBe(true);
    expect(hidden.has("close")).toBe(true);
    expect(hidden.has("end")).toBe(true);
  });

  it("counts a folded branch including its own head, for the chip that stands in for it", () => {
    expect(foldedCount(forked(), "rent1")).toBe(2);
    expect(foldedCount(forked(), "buy1")).toBe(1);
  });

  it("ignores a branch head that is no longer in the graph", () => {
    expect(foldedAway(forked(), ["deleted-yesterday"]).size).toBe(0);
  });

  it("names each branch by the answer that reaches it", () => {
    const fork = forked().nodes.find((n) => n.id === "fork");
    if (fork === undefined) throw new Error("no fork");

    expect(branchHeads(forked(), fork)).toEqual([
      { to: "rent1", label: "rent" },
      { to: "buy1", label: "anything else" },
    ]);
  });
});

describe("grouping the drawing into lanes", () => {
  it("names the shared opening and one lane per service", () => {
    expect(laneGroups(forked())).toEqual([
      { id: "opening", label: "everyone gets this", ids: ["start", "ask", "fork"] },
      { id: "rent1", label: "rent", ids: ["rent1", "rent2"] },
      { id: "buy1", label: "anything else", ids: ["buy1"] },
    ]);
  });

  /* The ending both services meet at belongs to neither, so it sits outside every lane —
     drawing it inside one would say a shared goodbye is part of booking a viewing. */
  it("leaves a shared ending out of every lane", () => {
    const inLanes = new Set(laneGroups(forked()).flatMap((lane) => lane.ids));

    expect(inLanes.has("close")).toBe(false);
    expect(inLanes.has("end")).toBe(false);
  });

  it("draws no lanes at all when the call never forks", () => {
    const straight: Flow = {
      version: 1,
      nodes: [node("start", "start"), node("ask"), node("end", "hangup")],
      edges: [
        { from: "start", to: "ask" },
        { from: "ask", to: "end" },
      ],
    };
    // A straight line has one lane, and a box round the whole drawing labels nothing.
    expect(laneGroups(straight)).toEqual([]);
  });

  it("keeps a fork inside a service in that service's lane rather than splitting the top", () => {
    const nested: Flow = {
      ...forked(),
      nodes: [...forked().nodes, node("inner", "decide"), node("deep")],
      edges: [
        ...forked().edges,
        { from: "rent2", to: "inner" },
        { from: "inner", to: "deep", otherwise: true },
        { from: "deep", to: "close" },
      ],
    };
    const lanes = laneGroups(nested);

    expect(lanes.map((lane) => lane.label)).toEqual(["everyone gets this", "rent", "anything else"]);
    expect(lanes.find((lane) => lane.id === "rent1")?.ids).toEqual(expect.arrayContaining(["inner", "deep"]));
  });
});

describe("growing the drawing", () => {
  const fresh = (id: string, kind: FlowNode["kind"] = "collect"): FlowNode => node(id, kind);
  const linksFrom = (flow: Flow, id: string) => flow.edges.filter((e) => e.from === id).map((e) => e.to);
  const linksTo = (flow: Flow, id: string) => flow.edges.filter((e) => e.to === id).map((e) => e.from);
  /* The fixture's steps are bare on purpose — no questions written on them — so the validator
     always has that to say. What the surgery must never cause is a *shape* problem: a step
     nothing reaches, a path with no way out, a fork with no catch-all. */
  const SHAPE = new Set(["unreachable", "dead-end", "decide-without-otherwise", "edge-to-nowhere", "cycle", "no-start", "many-starts", "shadowed-branch", "branch-value-not-an-option"]);
  const shapeProblems = (flow: Flow) => validateFlow(flow).filter((p) => SHAPE.has(p.code)).map((p) => `${p.code}@${p.nodeId ?? "flow"}`);

  it("puts a step dropped on a card between that card and whatever it led to", () => {
    const grown = insertAfter(forked(), "rent1", fresh("new"));

    expect(linksFrom(grown, "rent1")).toEqual(["new"]);
    expect(linksFrom(grown, "new")).toEqual(["rent2"]);
    expect(shapeProblems(grown)).toEqual([]);
  });

  it("keeps the port a link left by when a step is inserted after it", () => {
    const grown = insertAfter(forked(), "ask", fresh("new"));
    const into = grown.edges.find((e) => e.to === "new");

    // "ask" is a collect; its link to the fork had no port name, and still has none.
    expect(into?.port).toBeUndefined();
    expect(linksFrom(grown, "new")).toEqual(["fork"]);
  });

  it("gives a new branch the old link as its catch-all, so it can publish at once", () => {
    const grown = insertAfter(forked(), "rent1", fresh("split", "decide"));
    const onward = grown.edges.find((e) => e.from === "split");

    expect(onward?.to).toBe("rent2");
    expect(onward?.otherwise).toBe(true);
  });

  /* An ending dropped mid-path ends the path. What used to follow is cut loose and shown as
     unreachable — honest, where silently keeping a second link out of the card would not be. */
  it("lets an ending end the path, and leaves what followed visibly unreachable", () => {
    const grown = insertAfter(forked(), "rent1", fresh("bye", "hangup"));

    expect(linksFrom(grown, "rent1")).toEqual(["bye"]);
    expect(linksFrom(grown, "bye")).toEqual([]);
    expect(linksTo(grown, "rent2")).toEqual([]);
    expect(validateFlow(grown).some((p) => p.code === "unreachable" && p.nodeId === "rent2")).toBe(true);
  });

  it("puts a step dropped on the opening lane before the fork, so everybody is asked", () => {
    const lanes = laneGroups(forked());
    const opening = lanes.find((lane) => lane.id === "opening");
    if (opening === undefined) throw new Error("no opening lane");
    const grown = appendToLane(forked(), opening, fresh("new"));

    expect(linksFrom(grown, "ask")).toEqual(["new"]);
    expect(linksFrom(grown, "new")).toEqual(["fork"]);
    expect(laneGroups(grown).find((lane) => lane.id === "opening")?.ids).toContain("new");
  });

  it("puts a step dropped on a service after its last step, before the path rejoins", () => {
    const lanes = laneGroups(forked());
    const rent = lanes.find((lane) => lane.id === "rent1");
    if (rent === undefined) throw new Error("no rent lane");
    const grown = appendToLane(forked(), rent, fresh("new"));

    expect(linksFrom(grown, "rent2")).toEqual(["new"]);
    expect(linksFrom(grown, "new")).toEqual(["close"]);
    expect(laneGroups(grown).find((lane) => lane.id === "rent1")?.ids).toContain("new");
  });

  it("finds where the services meet again", () => {
    expect(rejoinPoint(forked(), laneGroups(forked()))).toBe("close");
  });

  it("adds a service as an option, a branch and a first step that rejoins — all three, or it would not publish", () => {
    const base: Flow = {
      ...forked(),
      nodes: forked().nodes.map((n) =>
        n.id === "ask"
          ? { ...n, field: { key: "intent", type: "choice", prompt: "Rent or buy?", capture: "speech", confirm: "none", pattern: "", attempts: 3, required: true, options: ["rent"] } }
          : n.id === "fork"
            ? { ...n, on: "intent" }
            : n,
      ),
    };
    const lanes = laneGroups(base);
    const grown = addService(base, lanes, fresh("viewHead"), "book a viewing");

    const ask = grown.nodes.find((n) => n.id === "ask");
    expect(ask?.field?.options).toEqual(["rent", "book a viewing"]);
    const branch = grown.edges.find((e) => e.from === "fork" && e.to === "viewHead");
    expect(branch?.when).toEqual({ equals: "book a viewing" });
    expect(linksFrom(grown, "viewHead")).toEqual(["close"]);
    // The catch-all stays last, so a named answer is always tried before "anything else".
    const forkEdges = grown.edges.filter((e) => e.from === "fork");
    expect(forkEdges[forkEdges.length - 1]?.otherwise).toBe(true);
    expect(laneGroups(grown).map((lane) => lane.label)).toEqual(["everyone gets this", "rent", "book a viewing", "anything else"]);
    expect(shapeProblems(grown)).toEqual([]);
  });

  it("names a new service so it never collides with one that exists", () => {
    expect(freshServiceName(forked(), laneGroups(forked()))).toBe("new service");
    const once = addService(forked(), laneGroups(forked()), fresh("h1"), "new service");
    expect(freshServiceName(once, laneGroups(once))).toBe("new service 2");
  });
});

describe("lanes with uneven depth", () => {
  /* Three services of two, three and one steps. Centring row by row put the second row's two
     cards under the gaps between three lanes; the lanes drawn round them then overlapped.
     Every card in a lane must sit in that lane's own column, whatever the rows above it hold. */
  it("keeps every card of a service inside that service's column", () => {
    const three: Flow = {
      ...forked(),
      nodes: [...forked().nodes, node("view1"), node("view2"), node("view3")],
      edges: [
        ...forked().edges.filter((e) => !(e.from === "fork" && e.otherwise === true)),
        { from: "fork", to: "view1", when: { equals: "viewing" } },
        { from: "view1", to: "view2" },
        { from: "view2", to: "view3" },
        { from: "view3", to: "close" },
        { from: "fork", to: "buy1", otherwise: true },
      ],
    };
    const laid = tidied(three);
    const x = (id: string) => laid.nodes.find((n) => n.id === id)?.x;

    // Each service is one column; a service's later steps share their head's column.
    expect(x("rent2")).toBe(x("rent1"));
    expect(x("view2")).toBe(x("view1"));
    expect(x("view3")).toBe(x("view1"));
    // And the three services are three different columns, in the fork's order.
    const cols = [x("rent1"), x("view1"), x("buy1")];
    expect(new Set(cols).size).toBe(3);
    expect(cols).toEqual([...cols].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });
});
