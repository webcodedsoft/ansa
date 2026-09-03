import { describe, expect, it } from "vitest";

import type { Flow, FlowEdge, FlowField, FlowNode } from "./flow";
import { FLOW_VERSION } from "./flow";
import { fieldsCollectedBefore, projectToCapturedFields } from "./flow-project";

const field = (key: string): FlowField => ({
  key,
  type: "text",
  prompt: `What is your ${key}?`,
  capture: "either",
  confirm: "none",
  pattern: "",
  attempts: 3,
  required: true,
  options: [],
});

const node = (id: string, kind: FlowNode["kind"], x: number, y: number): FlowNode =>
  ({ id, kind, x, y });

const collect = (id: string, key: string, x: number, y: number): FlowNode =>
  ({ id, kind: "collect", x, y, field: field(key) });

const flow = (nodes: readonly FlowNode[], edges: readonly FlowEdge[]): Flow =>
  ({ version: FLOW_VERSION, nodes, edges });

const keys = (fields: readonly FlowField[]): readonly string[] => fields.map((f) => f.key);

/**
 * start → name → phone → hangup. The order a call asks them is the order of the wire.
 */
const linear = flow(
  [
    node("start", "start", 0, 0),
    collect("one", "name", 0, 100),
    collect("two", "phone", 0, 200),
    node("end", "hangup", 0, 300),
  ],
  [
    { from: "start", to: "one" },
    { from: "one", to: "two" },
    { from: "two", to: "end" },
  ],
);

/**
 * start → reason → decide, two arms that collect different things, rejoining on `address`.
 *
 * The arms are drawn with the delivery arm above the pickup arm, so position decides which of
 * two genuinely unordered questions comes first.
 */
const branching = flow(
  [
    node("start", "start", 0, 200),
    collect("ask-reason", "reason", 100, 200),
    node("choose", "decide", 200, 200),
    collect("delivery", "delivery_date", 300, 100),
    collect("pickup", "pickup_time", 300, 300),
    collect("join", "address", 400, 200),
    node("end", "hangup", 500, 200),
  ],
  [
    { from: "start", to: "ask-reason" },
    { from: "ask-reason", to: "choose" },
    { from: "choose", to: "delivery", when: { equals: "delivery" } },
    { from: "choose", to: "pickup", otherwise: true },
    { from: "delivery", to: "join" },
    { from: "pickup", to: "join" },
    { from: "join", to: "end" },
  ],
);

describe("projectToCapturedFields", () => {
  it("projects a linear flow in the order the call asks", () => {
    expect(keys(projectToCapturedFields(linear))).toEqual(["name", "phone"]);
  });

  it("takes both arms of a branch, and the join after both of them", () => {
    expect(keys(projectToCapturedFields(branching))).toEqual([
      "reason",
      "delivery_date",
      "pickup_time",
      "address",
    ]);
  });

  it("never puts a joining question ahead of an arm that always precedes it", () => {
    // The join sits above the lower arm on the canvas. Position must not be allowed to
    // overrule the wire: every call collects both arms before it reaches the join.
    const dragged = flow(
      branching.nodes.map((n) => (n.id === "join" ? { ...n, y: 0 } : n)),
      branching.edges,
    );
    const order = keys(projectToCapturedFields(dragged));
    expect(order.indexOf("address")).toBeGreaterThan(order.indexOf("pickup_time"));
  });

  it("gives byte-identical output for the same graph twice", () => {
    // A publish with no edits must not read as a change. Deep equality, not identity.
    expect(projectToCapturedFields(branching)).toEqual(projectToCapturedFields(branching));
    expect(JSON.stringify(projectToCapturedFields(branching)))
      .toBe(JSON.stringify(projectToCapturedFields(branching)));
  });

  it("breaks a tie by canvas position, not by insertion order", () => {
    // Same graph, arms swapped top for bottom. The list must follow the canvas.
    const swapped = flow(
      branching.nodes.map((n) => {
        if (n.id === "delivery") return { ...n, y: 300 };
        if (n.id === "pickup") return { ...n, y: 100 };
        return n;
      }),
      branching.edges,
    );
    expect(keys(projectToCapturedFields(swapped))).toEqual([
      "reason",
      "pickup_time",
      "delivery_date",
      "address",
    ]);
  });

  it("ignores the order the nodes happen to sit in the array", () => {
    // Re-creating a node moves it to the end of `nodes`. That is invisible to the operator and
    // must therefore be invisible in the projection.
    const shuffled = flow([...branching.nodes].reverse(), [...branching.edges].reverse());
    expect(projectToCapturedFields(shuffled)).toEqual(projectToCapturedFields(branching));
  });

  it("breaks a same-row tie by x, then by id", () => {
    const sameRow = flow(
      [
        node("start", "start", 0, 0),
        node("choose", "decide", 100, 0),
        collect("b-node", "right", 300, 100),
        collect("a-node", "left", 200, 100),
        collect("z-node", "overlapping", 200, 100),
        node("end", "hangup", 400, 0),
      ],
      [
        { from: "start", to: "choose" },
        { from: "choose", to: "b-node" },
        { from: "choose", to: "a-node" },
        { from: "choose", to: "z-node", otherwise: true },
        { from: "b-node", to: "end" },
        { from: "a-node", to: "end" },
        { from: "z-node", to: "end" },
      ],
    );
    // a-node and z-node share a position, so the id decides between them; b-node is further
    // right and comes last.
    expect(keys(projectToCapturedFields(sameRow))).toEqual(["left", "overlapping", "right"]);
  });

  it("drops a collect node no call can reach", () => {
    // The trade-off is documented on the function: this list is handed to the prompt layer, so
    // an unreachable question would be asked on a live call that the graph says never gets
    // there. Losing the column is the lesser harm, and `unreachable` is already flagged.
    const stray = flow(
      [...linear.nodes, collect("orphan", "nin", 400, 400)],
      linear.edges,
    );
    expect(keys(projectToCapturedFields(stray))).toEqual(["name", "phone"]);
  });

  it("drops a node whose only wire in was cut", () => {
    const unwired = flow(branching.nodes, branching.edges.filter((e) => e.to !== "pickup"));
    expect(keys(projectToCapturedFields(unwired))).not.toContain("pickup_time");
  });

  it("emits a key once even when two arms collect it", () => {
    const both = flow(
      branching.nodes.map((n) => (n.id === "pickup" ? collect("pickup", "delivery_date", 300, 300) : n)),
      branching.edges,
    );
    expect(keys(projectToCapturedFields(both))).toEqual(["reason", "delivery_date", "address"]);
  });

  it("skips a collect node with no question on it yet", () => {
    const half = flow(
      [...linear.nodes, node("blank", "collect", 0, 400)],
      [...linear.edges, { from: "two", to: "blank" }],
    );
    expect(keys(projectToCapturedFields(half))).toEqual(["name", "phone"]);
  });

  it("returns nothing when there is no start node", () => {
    expect(projectToCapturedFields(flow([collect("one", "name", 0, 0)], []))).toEqual([]);
  });

  it("keeps every reachable question when the operator has wired a loop", () => {
    // A cycle is blocked at publish. The console still projects on every keystroke, and it must
    // terminate and keep the fields rather than hang or blank the table mid-edit.
    const looped = flow(linear.nodes, [...linear.edges, { from: "two", to: "one" }]);
    expect([...keys(projectToCapturedFields(looped))].sort()).toEqual(["name", "phone"]);
  });

  it("ignores an edge pointing at a node that is gone", () => {
    const dangling = flow(linear.nodes, [...linear.edges, { from: "one", to: "deleted" }]);
    expect(keys(projectToCapturedFields(dangling))).toEqual(["name", "phone"]);
  });
});

describe("fieldsCollectedBefore", () => {
  it("gives everything asked earlier on a straight line", () => {
    expect([...fieldsCollectedBefore(linear, "two")]).toEqual(["name"]);
  });

  it("does not include the node's own question", () => {
    expect(fieldsCollectedBefore(linear, "one").has("name")).toBe(false);
  });

  it("gives nothing at the start", () => {
    expect([...fieldsCollectedBefore(linear, "start")]).toEqual([]);
  });

  it("intersects the arms rather than unioning them", () => {
    // `address` is after the join, and only `reason` is collected on every path to it. Offering
    // `delivery_date` here would branch on a value that is empty on every pickup call.
    const before = fieldsCollectedBefore(branching, "join");
    expect([...before]).toEqual(["reason"]);
    expect(before.has("delivery_date")).toBe(false);
    expect(before.has("pickup_time")).toBe(false);
  });

  it("keeps a field that both arms happen to collect", () => {
    const both = flow(
      branching.nodes.map((n) => (n.id === "pickup" ? collect("pickup", "delivery_date", 300, 300) : n)),
      branching.edges,
    );
    expect([...fieldsCollectedBefore(both, "join")].sort()).toEqual(["delivery_date", "reason"]);
  });

  it("offers a decide node only what was asked before the branch", () => {
    expect([...fieldsCollectedBefore(branching, "choose")]).toEqual(["reason"]);
  });

  it("sees what the arm itself collected, further down that arm", () => {
    const deeper = flow(
      [...branching.nodes, collect("after", "flat_number", 350, 100)],
      [
        ...branching.edges.filter((e) => !(e.from === "delivery" && e.to === "join")),
        { from: "delivery", to: "after" },
        { from: "after", to: "join" },
      ],
    );
    expect([...fieldsCollectedBefore(deeper, "after")].sort()).toEqual(["delivery_date", "reason"]);
    // And the join still only guarantees what both arms guarantee.
    expect([...fieldsCollectedBefore(deeper, "join")]).toEqual(["reason"]);
  });

  it("gives nothing for a node no call can reach", () => {
    const stray = flow([...linear.nodes, collect("orphan", "nin", 400, 400)], linear.edges);
    expect([...fieldsCollectedBefore(stray, "orphan")]).toEqual([]);
    expect([...fieldsCollectedBefore(stray, "nowhere")]).toEqual([]);
  });

  it("terminates on a loop and still guarantees what the entry path collected", () => {
    const looped = flow(
      [...linear.nodes, node("again", "decide", 0, 250)],
      [
        { from: "start", to: "one" },
        { from: "one", to: "two" },
        { from: "two", to: "again" },
        { from: "again", to: "one" },
        { from: "again", to: "end", otherwise: true },
      ],
    );
    expect([...fieldsCollectedBefore(looped, "two")]).toEqual(["name"]);
  });
});
