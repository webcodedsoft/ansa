import type { Flow, FlowNode } from "./flow.schema";
import { describe, expect, it } from "vitest";

import { validateFlow } from "@ansa/shared/flow-validate";

import {
  addService, appendToLane, branchHeads, detach, foldedAway, foldedCount, freshServiceName, insertAfter, jumpEdges, laneFrames,
  laneGroups, linkToService, moveAfter, moveBefore, moveToLane, moveToNewService, onlyReachableThrough, rejoinPoint, removeService, renameService,
  reorderService, ROW, sameShape, serviceOf, tidied, TOP, withServiceTags,
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

    expect(branchHeads(forked(), fork).map(({ to, label }) => ({ to, label }))).toEqual([
      { to: "rent1", label: "rent" },
      { to: "buy1", label: "anything else" },
    ]);
  });
});

describe("grouping the drawing into lanes", () => {
  it("names the shared opening and one lane per service", () => {
    expect(laneGroups(forked())).toEqual([
      { id: "opening", label: "everyone gets this", ids: ["start", "ask", "fork"] },
      { id: "svc:rent", label: "rent", ids: ["rent1", "rent2"], fork: "fork", head: "rent1" },
      { id: "svc:anything else", label: "anything else", ids: ["buy1"], fork: "fork", head: "buy1", catchAll: true },
    ]);
  });

  /* A flow saved before steps carried their service is read by the old rule once — a
     service was whatever one branch reached — and the names are written onto the steps, so
     from then on the lanes are what the steps say and not what the links happen to reach. */
  it("names the steps of a flow that predates services, and leaves the shared ones alone", () => {
    const named = withServiceTags(forked());
    const service = (id: string) => serviceOf(named.nodes.find((n) => n.id === id) ?? node("none"));
    expect([service("rent1"), service("rent2"), service("buy1")]).toEqual(["rent", "rent", "anything else"]);
    expect([service("start"), service("ask"), service("fork"), service("close"), service("end")]).toEqual([undefined, undefined, undefined, undefined, undefined]);
    // Idempotent, and the same object when nothing needs naming.
    expect(withServiceTags(named)).toBe(named);
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
    expect(lanes.find((lane) => lane.label === "rent")?.ids).toEqual(expect.arrayContaining(["inner", "deep"]));
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
    const rent = lanes.find((lane) => lane.label === "rent");
    if (rent === undefined) throw new Error("no rent lane");
    const grown = appendToLane(forked(), rent, fresh("new"));

    expect(linksFrom(grown, "rent2")).toEqual(["new"]);
    expect(linksFrom(grown, "new")).toEqual(["close"]);
    expect(laneGroups(grown).find((lane) => lane.label === "rent")?.ids).toContain("new");
  });

  it("finds where the services meet again", () => {
    expect(rejoinPoint(forked(), laneGroups(forked()))).toBe("close");
  });

  it("adds a service as a name and a first step, and leads nothing to it", () => {
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
    const grown = addService(base, fresh("viewHead"), "book a viewing");

    /* The service exists — a lane, last, where the "add a service" box was — and nothing
       is attached to it: not the fork, not the choice. Which answer takes a caller there is
       the business's to say, by dragging a branch onto it. */
    expect(grown.nodes.find((n) => n.id === "ask")?.field?.options).toEqual(["rent"]);
    expect(grown.edges.some((e) => e.to === "viewHead" || e.from === "viewHead")).toBe(false);
    expect(laneGroups(grown).map((lane) => lane.label)).toEqual(["everyone gets this", "rent", "anything else", "book a viewing"]);
    expect(laneGroups(grown).find((lane) => lane.label === "book a viewing")?.ids).toEqual(["viewHead"]);
    // Drawn at the top of the lanes like any service, and in its own column.
    const laid = tidied(grown);
    const at = (id: string) => laid.nodes.find((n) => n.id === id);
    expect(at("viewHead")?.y).toBe(at("rent1")?.y);
    expect(new Set([at("rent1")?.x, at("buy1")?.x, at("viewHead")?.x]).size).toBe(3);
  });

  it("leads a branch onto a service: from the fork, with the service's name as the answer and the option", () => {
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
    const grown = addService(base, fresh("viewHead"), "book a viewing");
    const viewing = laneGroups(grown).find((lane) => lane.label === "book a viewing");
    if (viewing === undefined) throw new Error("no viewing lane");

    const linked = linkToService(grown, { from: "fork", to: "", when: { equals: "" } }, viewing);
    expect(linked.edges.find((e) => e.from === "fork" && e.to === "viewHead")?.when).toEqual({ equals: "book a viewing" });
    expect(linked.nodes.find((n) => n.id === "ask")?.field?.options).toEqual(["rent", "book a viewing"]);
    expect(laneGroups(linked).find((lane) => lane.label === "book a viewing")?.ids).toEqual(["viewHead"]);

    // From a branch inside a service the name is a starting guess at the answer, and no option is added.
    const inner: Flow = { ...grown, nodes: [...grown.nodes, node("inner", "decide")], edges: [...grown.edges, { from: "rent2", to: "inner" }, { from: "inner", to: "close", otherwise: true }] };
    const jumped = linkToService(inner, { from: "inner", to: "", when: { equals: "" } }, laneGroups(inner).find((lane) => lane.label === "book a viewing") ?? viewing);
    expect(jumped.edges.find((e) => e.from === "inner" && e.to === "viewHead")?.when).toEqual({ equals: "book a viewing" });
    expect(jumped.nodes.find((n) => n.id === "ask")?.field?.options).toEqual(["rent"]);
    expect([...jumpEdges(jumped)]).toMatchObject([{ from: "inner", to: "viewHead" }]);
  });

  it("names a new service so it never collides with one that exists", () => {
    expect(freshServiceName(forked())).toBe("new service");
    const once = addService(forked(), fresh("h1"), "new service");
    expect(freshServiceName(once)).toBe("new service 2");
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
    // And the three services are three different columns, in the order the services are listed.
    const cols = [x("rent1"), x("buy1"), x("view1")];
    expect(new Set(cols).size).toBe(3);
    expect(cols).toEqual([...cols].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });
});

describe("moving steps and services", () => {
  const linksFrom = (flow: Flow, id: string) => flow.edges.filter((e) => e.from === id).map((e) => e.to);
  const SHAPE = new Set(["unreachable", "dead-end", "decide-without-otherwise", "edge-to-nowhere", "cycle", "no-start", "many-starts", "shadowed-branch", "branch-value-not-an-option"]);
  const shapeProblems = (flow: Flow) => validateFlow(flow).filter((p) => SHAPE.has(p.code)).map((p) => `${p.code}@${p.nodeId ?? "flow"}`);
  /** The fixture with the fork wired to a real choice, so services can be added and renamed. */
  const withChoice = (): Flow => ({
    ...forked(),
    nodes: forked().nodes.map((n) =>
      n.id === "ask"
        ? { ...n, field: { key: "intent", type: "choice", prompt: "Rent or buy?", capture: "speech", confirm: "none", pattern: "", attempts: 3, required: true, options: ["rent"] } }
        : n.id === "fork"
          ? { ...n, on: "intent" }
          : n,
    ),
  });

  it("closes the gap a lifted step leaves, so the call skips it rather than stopping at it", () => {
    const lifted = detach(forked(), "rent1");
    expect(linksFrom(lifted, "fork")).toEqual(["rent2", "buy1"]);
    expect(linksFrom(lifted, "rent1")).toEqual([]);
    // The step is still there — a move puts it back somewhere.
    expect(lifted.nodes.some((n) => n.id === "rent1")).toBe(true);
  });

  it("moves a step after another, taking it off its old path first", () => {
    const moved = moveAfter(forked(), "rent2", "buy1");
    expect(linksFrom(moved, "rent1")).toEqual(["close"]);
    expect(linksFrom(moved, "buy1")).toEqual(["rent2"]);
    expect(linksFrom(moved, "rent2")).toEqual(["close"]);
    expect(moved.nodes).toHaveLength(forked().nodes.length);
    expect(shapeProblems(moved)).toEqual([]);
  });

  it("moves a step to the top of a service, so the branch leads to it first", () => {
    const moved = moveBefore(forked(), "rent2", "buy1");
    expect(linksFrom(moved, "fork")).toEqual(["rent1", "rent2"]);
    expect(linksFrom(moved, "rent2")).toEqual(["buy1"]);
    expect(linksFrom(moved, "rent1")).toEqual(["close"]);
    expect(laneGroups(moved).find((lane) => lane.label === "anything else")?.ids).toEqual(["rent2", "buy1"]);
    expect(shapeProblems(moved)).toEqual([]);
    // Nothing goes before the answer: "before the start" lands right after it.
    const first = moveBefore(forked(), "rent2", "start");
    expect(linksFrom(first, "start")).toEqual(["rent2"]);
    expect(linksFrom(first, "rent2")).toEqual(["ask"]);
  });

  it("moves a step to the end of another service", () => {
    const lanes = laneGroups(forked());
    const buy = lanes.find((lane) => lane.label === "anything else");
    if (buy === undefined) throw new Error("no buy lane");
    const moved = moveToLane(forked(), "rent1", buy);
    expect(linksFrom(moved, "fork")).toEqual(["rent2", "buy1"]);
    expect(linksFrom(moved, "buy1")).toEqual(["rent1"]);
    expect(linksFrom(moved, "rent1")).toEqual(["close"]);
    expect(shapeProblems(moved)).toEqual([]);
  });

  it("refuses to move the start or a fork, and a drop onto itself changes nothing", () => {
    const base = forked();
    expect(moveAfter(base, "fork", "buy1")).toBe(base);
    expect(moveAfter(base, "start", "buy1")).toBe(base);
    expect(moveAfter(base, "rent1", "rent1")).toBe(base);
  });

  it("keeps a service whose steps were all moved away, drawn empty and still owning a column", () => {
    const lanes = laneGroups(forked());
    const buy = lanes.find((lane) => lane.label === "anything else");
    if (buy === undefined) throw new Error("no buy lane");
    // Move both rent steps to the other service: the rent branch now points straight at the close.
    const once = moveToLane(forked(), "rent1", buy);
    const twice = moveToLane(once, "rent2", laneGroups(once).find((lane) => lane.label === "anything else") ?? buy);
    expect(linksFrom(twice, "fork")).toEqual(["close", "buy1"]);

    const after = laneGroups(twice);
    const rent = after.find((lane) => lane.label === "rent");
    expect(rent?.ids).toEqual([]);
    expect(rent?.head).toBe("close");
    // The close is nobody's: it is shared, and it is drawn between the lanes as before.
    expect(after.flatMap((lane) => lane.ids)).not.toContain("close");
    expect(laneFrames(twice).map((frame) => frame.id)).toEqual(["svc:anything else", "via:rent"]);
    expect(shapeProblems(twice)).toEqual([]);

    // A step dropped onto the empty lane goes on its branch and leads on to the close.
    const refilled = appendToLane(twice, rent ?? buy, node("back"));
    expect(linksFrom(refilled, "fork")).toEqual(["back", "buy1"]);
    expect(linksFrom(refilled, "back")).toEqual(["close"]);
    expect(laneGroups(refilled).find((lane) => lane.label === "rent")?.ids).toEqual(["back"]);
  });

  it("makes a moved step the first step of a new service, attached to nothing", () => {
    const grown = moveToNewService(withChoice(), "rent2", "book a viewing");
    expect(linksFrom(grown, "rent1")).toEqual(["close"]);
    expect(grown.edges.some((e) => e.to === "rent2" || e.from === "rent2")).toBe(false);
    expect(serviceOf(grown.nodes.find((n) => n.id === "rent2") ?? node("none"))).toBe("book a viewing");
    expect(laneGroups(grown).map((lane) => lane.label)).toEqual(["everyone gets this", "rent", "anything else", "book a viewing"]);
    // The step is on the drawing and in its lane; that nothing leads to it is the validator's to say.
    expect(shapeProblems(grown)).toEqual(["unreachable@rent2"]);
  });

  it("draws a service before another, or last, without changing where any answer leads", () => {
    const base = withChoice();
    const three = addService(base, node("viewHead"), "book a viewing");
    const lanes = laneGroups(three);
    const viewing = lanes.find((lane) => lane.label === "book a viewing");
    const rent = lanes.find((lane) => lane.label === "rent");
    if (viewing === undefined || rent === undefined) throw new Error("lanes missing");

    const first = reorderService(three, viewing, rent);
    expect(laneGroups(first).map((lane) => lane.label)).toEqual(["everyone gets this", "book a viewing", "rent", "anything else"]);
    const last = reorderService(first, laneGroups(first).find((lane) => lane.label === "rent") ?? rent, null);
    expect(laneGroups(last).map((lane) => lane.label)).toEqual(["everyone gets this", "book a viewing", "anything else", "rent"]);
    // Same links, only in a different order.
    expect(new Set(last.edges.map((e) => JSON.stringify(e)))).toEqual(new Set(three.edges.map((e) => JSON.stringify(e))));
  });

  it("removes a service with its branch, its option and its own steps, and never the catch-all", () => {
    const base = withChoice();
    const rent = laneGroups(base).find((lane) => lane.label === "rent");
    if (rent === undefined) throw new Error("no rent lane");

    const gone = removeService(base, rent);
    expect(gone.nodes.map((n) => n.id)).toEqual(["start", "ask", "fork", "buy1", "close", "end"]);
    expect(gone.edges.some((e) => e.to === "rent1" || e.from === "rent2")).toBe(false);
    expect(gone.nodes.find((n) => n.id === "ask")?.field?.options).toEqual([]);
    expect(laneGroups(gone).map((lane) => lane.label)).toEqual(["everyone gets this", "anything else"]);
    // The shared close survives: it was never only rent's.
    expect(shapeProblems(gone)).toEqual([]);

    const catchAll = laneGroups(base).find((lane) => lane.label === "anything else");
    expect(removeService(base, catchAll ?? rent)).toBe(base);
  });

  it("names the catch-all by the one option the named branches leave uncovered, and renames that option", () => {
    /* A template's "rent or buy" draws buy as the catch-all so the fork can publish. On the
       canvas that lane is still the buy service, and it must say so and be renameable. */
    const base: Flow = {
      ...withChoice(),
      nodes: withChoice().nodes.map((n) => (n.id === "ask" && n.field !== undefined ? { ...n, field: { ...n.field, options: ["rent", "buy"] } } : n)),
    };
    const lanes = laneGroups(base);
    expect(lanes.map((lane) => lane.label)).toEqual(["everyone gets this", "rent", "buy"]);
    const buy = lanes[2];
    expect(buy?.catchAll).toBe(true);
    if (buy === undefined) throw new Error("no buy lane");

    const renamed = renameService(base, buy, "purchase");
    expect(renamed.nodes.find((n) => n.id === "ask")?.field?.options).toEqual(["rent", "purchase"]);
    expect(renamed.edges.find((e) => e.to === "buy1")).toEqual({ from: "fork", to: "buy1", otherwise: true });
    expect(laneGroups(renamed).map((lane) => lane.label)).toEqual(["everyone gets this", "rent", "purchase"]);
    expect(renameService(base, buy, "rent")).toBe(base);

    // With two options uncovered there is no one name to give it.
    const wide: Flow = { ...base, nodes: base.nodes.map((n) => (n.id === "ask" && n.field !== undefined ? { ...n, field: { ...n.field, options: ["rent", "buy", "let"] } } : n)) };
    expect(laneGroups(wide)[2]?.label).toBe("anything else");
    // And an empty catch-all lane is keyed by that name, the way a named one is.
    expect(removeService(base, buy)).toBe(base);
  });

  it("renames a service on the branch and on the choice together, and refuses a taken name", () => {
    const base = withChoice();
    const rent = laneGroups(base).find((lane) => lane.label === "rent");
    if (rent === undefined) throw new Error("no rent lane");

    const renamed = renameService(base, rent, " lettings ");
    expect(renamed.edges.find((e) => e.to === "rent1")?.when).toEqual({ equals: "lettings" });
    expect(renamed.nodes.find((n) => n.id === "ask")?.field?.options).toEqual(["lettings"]);
    expect(laneGroups(renamed).map((lane) => lane.label)).toEqual(["everyone gets this", "lettings", "anything else"]);
    expect(shapeProblems(renamed)).toEqual([]);

    const grown = addService(base, node("viewHead"), "book a viewing");
    const clash = renameService(grown, laneGroups(grown).find((lane) => lane.label === "rent") ?? rent, "book a viewing");
    expect(clash).toBe(grown);
    const catchAll = laneGroups(base).find((lane) => lane.label === "anything else");
    expect(renameService(base, catchAll ?? rent, "other")).toBe(base);
  });
});

describe("a branch that jumps to another service", () => {
  /* start → ask → fork ⟨rent | buy⟩, and inside rent a branch whose named arm sends the
     caller to the buying questions instead. The jump is real and must be drawn; it must not
     decide which steps belong to which service, or how far down the page they sit. */
  const jumped = (): Flow => ({
    ...forked(),
    nodes: [...forked().nodes, node("inner", "decide"), node("buy2")],
    edges: [
      ...forked().edges.filter((e) => !(e.from === "rent1" && e.to === "rent2") && !(e.from === "buy1" && e.to === "close")),
      { from: "rent1", to: "inner" },
      { from: "inner", to: "rent2", otherwise: true },
      { from: "inner", to: "buy1", when: { equals: "buying instead" } },
      { from: "buy1", to: "buy2" },
      { from: "buy2", to: "close" },
    ],
  });

  it("keeps the service it points at, rather than emptying it", () => {
    const lanes = laneGroups(jumped());
    expect(lanes.map((lane) => lane.label)).toEqual(["everyone gets this", "rent", "anything else"]);
    expect(lanes.find((lane) => lane.label === "rent")?.ids).toEqual(expect.arrayContaining(["rent1", "inner", "rent2"]));
    expect(lanes.find((lane) => lane.label === "anything else")?.ids).toEqual(["buy1", "buy2"]);
  });

  it("names the jump and nothing else", () => {
    const jumps = [...jumpEdges(jumped())];
    expect(jumps).toHaveLength(1);
    expect(jumps[0]).toMatchObject({ from: "inner", to: "buy1" });
  });

  it("draws the step it points at where the service puts it, not below the jump", () => {
    const laid = tidied(jumped());
    const at = (id: string) => laid.nodes.find((n) => n.id === id);
    // Both services still start on the row under the fork, side by side.
    expect(at("buy1")?.y).toBe(at("rent1")?.y);
    expect(at("buy1")?.x).not.toBe(at("rent1")?.x);
    // And nothing is drawn on top of anything else.
    const places = laid.nodes.map((n) => `${n.x},${n.y}`);
    expect(new Set(places).size).toBe(places.length);
  });

  it("treats a link into the middle of a service as a step the two share, not as a jump", () => {
    /* Landing past a service's first question is not entering that service, and the drawing
       says so: the step two services reach is drawn between them, where shared steps go. */
    const flow = jumped();
    const middle: Flow = { ...flow, edges: flow.edges.map((e) => (e.from === "inner" && e.to === "buy1" ? { ...e, to: "buy2" } : e)) };
    expect([...jumpEdges(middle)]).toEqual([]);
    expect(laneGroups(middle).find((lane) => lane.label === "anything else")?.ids).toEqual(["buy1"]);
    expect(laneGroups(middle).flatMap((lane) => lane.ids)).not.toContain("buy2");
  });

  it("folds the service it points at without leaving its steps behind", () => {
    const flow = jumped();
    const gone = foldedAway(flow, ["buy1"]);
    expect([...gone].sort()).toEqual(["buy1", "buy2"]);
    expect(foldedCount(flow, "buy1")).toBe(2);
  });
});
