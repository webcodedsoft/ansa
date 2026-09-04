import type { Flow, FlowNode } from "./flow.schema";
import { describe, expect, it } from "vitest";

import { branchHeads, foldedAway, foldedCount, onlyReachableThrough, ROW, sameShape, tidied, TOP } from "./flow-layout";

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
