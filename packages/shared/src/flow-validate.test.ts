import { describe, expect, it } from "vitest";

import {
  FLOW_VERSION,
  MAX_FLOW_FIELDS,
  type Flow,
  type FlowEdge,
  type FlowField,
  type FlowNode,
  type FlowNodeKind,
  type FlowProblem,
} from "./flow";
import { validateFlow } from "./flow-validate";

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

const node = (
  id: string,
  kind: FlowNodeKind,
  extra: Omit<Partial<FlowNode>, "id" | "kind"> = {},
): FlowNode => ({ id, kind, x: 0, y: 0, ...extra });

const asks = (id: string, key: string): FlowNode => node(id, "collect", { field: field(key) });

const graph = (nodes: readonly FlowNode[], edges: readonly FlowEdge[]): Flow => ({
  version: FLOW_VERSION,
  nodes,
  edges,
});

const codes = (flow: Flow): readonly string[] => validateFlow(flow).map((p) => p.code);

const only = (flow: Flow, code: FlowProblem["code"]): readonly FlowProblem[] =>
  validateFlow(flow).filter((p) => p.code === code);

const landsOn = (flow: Flow, code: FlowProblem["code"]): readonly (string | null)[] =>
  only(flow, code).map((p) => p.nodeId);

/**
 * A flow that is genuinely publishable: one start, one question, one branch on an answer the
 * call is certain to be holding, both ways out ending the call. Every failing case below is a
 * single deliberate edit away from this, so a rule that fires on the wrong thing shows up as
 * this test going red rather than as a false negative nobody notices.
 */
const branching = (): Flow =>
  graph(
    [
      node("s", "start"),
      asks("size", "size"),
      node("d", "decide", { on: "size" }),
      node("big", "say", { text: "Acknowledge the large order." }),
      node("small", "say", { text: "Acknowledge the small order." }),
      node("check", "decide", { on: "size" }),
      node("bye", "hangup"),
      node("human", "transfer"),
    ],
    [
      { from: "s", to: "size" },
      { from: "size", to: "d" },
      { from: "d", to: "big", when: { equals: "large" } },
      { from: "d", to: "small", otherwise: true },
      { from: "big", to: "check" },
      { from: "small", to: "check" },
      { from: "check", to: "bye", when: { equals: "large" } },
      { from: "check", to: "human", otherwise: true },
    ],
  );

describe("flows that are allowed to answer a phone", () => {
  it("finds nothing wrong with a straight line of steps", () => {
    const flow = graph(
      [
        node("s", "start"),
        node("hello", "say", { text: "Greet the caller." }),
        asks("ref", "reference"),
        node("bye", "hangup"),
      ],
      [
        { from: "s", to: "hello" },
        { from: "hello", to: "ref" },
        { from: "ref", to: "bye" },
      ],
    );

    expect(validateFlow(flow)).toEqual([]);
  });

  it("finds nothing wrong with a flow that branches and merges again", () => {
    expect(validateFlow(branching())).toEqual([]);
  });
});

describe("no-start / many-starts", () => {
  it("reports a flow with no starting step, against the flow rather than a node", () => {
    const flow = graph(
      [node("hello", "say", { text: "Greet." }), node("bye", "hangup")],
      [{ from: "hello", to: "bye" }],
    );

    expect(landsOn(flow, "no-start")).toEqual([null]);
    expect(only(flow, "no-start")[0]?.blocking).toBe(true);
  });

  it("does not also call every step unreachable when there is no start", () => {
    const flow = graph(
      [node("hello", "say", { text: "Greet." }), node("bye", "hangup")],
      [{ from: "hello", to: "bye" }],
    );

    expect(codes(flow)).toEqual(["no-start"]);
  });

  it("marks every candidate when there is more than one starting step", () => {
    const flow = graph(
      [node("a", "start"), node("b", "start"), node("bye", "hangup")],
      [
        { from: "a", to: "bye" },
        { from: "b", to: "bye" },
      ],
    );

    expect(landsOn(flow, "many-starts")).toEqual(["a", "b"]);
  });
});

describe("dead-end", () => {
  it("reports a reachable step with nothing leading out of it", () => {
    const flow = graph(
      [node("s", "start"), node("hello", "say", { text: "Greet." })],
      [{ from: "s", to: "hello" }],
    );

    expect(landsOn(flow, "dead-end")).toEqual(["hello"]);
  });

  it("reports the start itself when nothing leads out of it", () => {
    const flow = graph([node("s", "start")], []);

    expect(landsOn(flow, "dead-end")).toEqual(["s"]);
  });

  it("does not report a step that ends the call", () => {
    const flow = graph(
      [node("s", "start"), node("human", "transfer"), node("bye", "hangup")],
      [
        { from: "s", to: "human" },
        { from: "s", to: "bye" },
      ],
    );

    expect(codes(flow)).toEqual([]);
  });

  it("does not report an unreachable step with no way out, which will never run anyway", () => {
    const flow = graph(
      [node("s", "start"), node("bye", "hangup"), node("orphan", "say", { text: "Never." })],
      [{ from: "s", to: "bye" }],
    );

    expect(landsOn(flow, "dead-end")).toEqual([]);
  });
});

describe("cycle", () => {
  it("reports the step the call comes back round to", () => {
    const flow = graph(
      [
        node("s", "start"),
        node("a", "say", { text: "Ask again." }),
        node("b", "say", { text: "And again." }),
        node("bye", "hangup"),
      ],
      [
        { from: "s", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "a" },
        { from: "b", to: "bye" },
      ],
    );

    expect(landsOn(flow, "cycle")).toEqual(["a"]);
  });

  it("reports a step that leads straight back to itself", () => {
    const flow = graph(
      [node("s", "start"), node("a", "say", { text: "Loop." }), node("bye", "hangup")],
      [
        { from: "s", to: "a" },
        { from: "a", to: "a" },
        { from: "a", to: "bye" },
      ],
    );

    expect(landsOn(flow, "cycle")).toEqual(["a"]);
  });

  it("does not mistake two paths that merge again for a loop", () => {
    // The diamond in `branching()` visits `check` twice during the walk. A visited-set that
    // did not distinguish "on the current path" from "already finished" would call that a loop.
    expect(landsOn(branching(), "cycle")).toEqual([]);
  });

  it("does not report a loop that nothing reaches", () => {
    const flow = graph(
      [
        node("s", "start"),
        node("bye", "hangup"),
        node("a", "say", { text: "Orphan." }),
        node("b", "say", { text: "Orphan." }),
      ],
      [
        { from: "s", to: "bye" },
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    );

    expect(landsOn(flow, "cycle")).toEqual([]);
  });
});

describe("unreachable", () => {
  it("reports steps nothing leads to, without blocking the publish", () => {
    const flow = graph(
      [
        node("s", "start"),
        node("bye", "hangup"),
        node("orphan", "say", { text: "Never." }),
      ],
      [
        { from: "s", to: "bye" },
        { from: "orphan", to: "bye" },
      ],
    );

    expect(landsOn(flow, "unreachable")).toEqual(["orphan"]);
    expect(only(flow, "unreachable")[0]?.blocking).toBe(false);
    expect(codes(flow)).toEqual(["unreachable"]);
  });
});

describe("decide-on-missing-field", () => {
  /**
   * The case the whole rule exists for. `topping` is asked for on the large branch and not on
   * the other, and the two branches meet at a step that reads `topping`. Take the small route
   * and the call arrives at `merge` with nothing to branch on.
   */
  const oneBranchOnly = (): Flow =>
    graph(
      [
        node("s", "start"),
        asks("size", "size"),
        node("d", "decide", { on: "size" }),
        asks("topping", "topping"),
        node("merge", "decide", { on: "topping" }),
        node("bye", "hangup"),
        node("human", "transfer"),
      ],
      [
        { from: "s", to: "size" },
        { from: "size", to: "d" },
        { from: "d", to: "topping", when: { equals: "large" } },
        { from: "d", to: "merge", otherwise: true },
        { from: "topping", to: "merge" },
        { from: "merge", to: "bye", when: { equals: "cheese" } },
        { from: "merge", to: "human", otherwise: true },
      ],
    );

  it("fails when the answer is collected on one incoming branch but not the other", () => {
    expect(validateFlow(oneBranchOnly())).toEqual([
      {
        nodeId: "merge",
        code: "decide-on-missing-field",
        message: expect.stringContaining("topping") as unknown as string,
        blocking: true,
      },
    ]);
  });

  it("passes once the same answer is asked for before the branch instead", () => {
    // Same graph, `topping` lifted above the split so every route collects it. If the rule
    // were unioning paths instead of intersecting them, both this and the case above would
    // pass and the rule would be worthless.
    const flow = graph(
      [
        node("s", "start"),
        asks("size", "size"),
        asks("topping", "topping"),
        node("d", "decide", { on: "size" }),
        node("big", "say", { text: "Large." }),
        node("merge", "decide", { on: "topping" }),
        node("bye", "hangup"),
        node("human", "transfer"),
      ],
      [
        { from: "s", to: "size" },
        { from: "size", to: "topping" },
        { from: "topping", to: "d" },
        { from: "d", to: "big", when: { equals: "large" } },
        { from: "d", to: "merge", otherwise: true },
        { from: "big", to: "merge" },
        { from: "merge", to: "bye", when: { equals: "cheese" } },
        { from: "merge", to: "human", otherwise: true },
      ],
    );

    expect(validateFlow(flow)).toEqual([]);
  });

  it("fails when the answer is never collected anywhere", () => {
    const flow = graph(
      [
        node("s", "start"),
        node("d", "decide", { on: "size" }),
        node("bye", "hangup"),
        node("human", "transfer"),
      ],
      [
        { from: "s", to: "d" },
        { from: "d", to: "bye", when: { equals: "large" } },
        { from: "d", to: "human", otherwise: true },
      ],
    );

    expect(landsOn(flow, "decide-on-missing-field")).toEqual(["d"]);
  });

  it("fails when the step never names an answer at all", () => {
    const flow = graph(
      [node("s", "start"), node("d", "decide"), node("bye", "hangup"), node("human", "transfer")],
      [
        { from: "s", to: "d" },
        { from: "d", to: "bye", when: { equals: "yes" } },
        { from: "d", to: "human", otherwise: true },
      ],
    );

    expect(landsOn(flow, "decide-on-missing-field")).toEqual(["d"]);
  });

  it("says nothing about a branch the call can never reach", () => {
    const flow = graph(
      [
        node("s", "start"),
        node("bye", "hangup"),
        node("d", "decide", { on: "size" }),
        node("human", "transfer"),
      ],
      [
        { from: "s", to: "bye" },
        { from: "d", to: "human", otherwise: true },
      ],
    );

    expect(landsOn(flow, "decide-on-missing-field")).toEqual([]);
    expect(landsOn(flow, "unreachable")).toEqual(["d", "human"]);
  });
});

describe("decide-without-otherwise", () => {
  it("reports a branch with no catch-all", () => {
    const flow = graph(
      [
        node("s", "start"),
        asks("size", "size"),
        node("d", "decide", { on: "size" }),
        node("bye", "hangup"),
        node("human", "transfer"),
      ],
      [
        { from: "s", to: "size" },
        { from: "size", to: "d" },
        { from: "d", to: "bye", when: { equals: "large" } },
        { from: "d", to: "human", when: { equals: "small" } },
      ],
    );

    expect(landsOn(flow, "decide-without-otherwise")).toEqual(["d"]);
  });

  it("reports a branch with two catch-alls", () => {
    const flow = graph(
      [
        node("s", "start"),
        asks("size", "size"),
        node("d", "decide", { on: "size" }),
        node("bye", "hangup"),
        node("human", "transfer"),
      ],
      [
        { from: "s", to: "size" },
        { from: "size", to: "d" },
        { from: "d", to: "bye", otherwise: true },
        { from: "d", to: "human", otherwise: true },
      ],
    );

    expect(landsOn(flow, "decide-without-otherwise")).toEqual(["d"]);
  });
});

describe("collect-without-field", () => {
  it("reports a question step with no question on it", () => {
    const flow = graph(
      [node("s", "start"), node("ask", "collect"), node("bye", "hangup")],
      [
        { from: "s", to: "ask" },
        { from: "ask", to: "bye" },
      ],
    );

    expect(landsOn(flow, "collect-without-field")).toEqual(["ask"]);
  });
});

describe("duplicate-field-key", () => {
  it("reports the later of two steps saving under the same name", () => {
    const flow = graph(
      [node("s", "start"), asks("a", "reference"), asks("b", "reference"), node("bye", "hangup")],
      [
        { from: "s", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "bye" },
      ],
    );

    expect(landsOn(flow, "duplicate-field-key")).toEqual(["b"]);
  });
});

describe("too-many-fields", () => {
  const chainOf = (count: number): Flow => {
    const nodes: FlowNode[] = [node("s", "start")];
    const edges: FlowEdge[] = [];
    let previous = "s";
    for (let i = 0; i < count; i += 1) {
      const id = `q${i}`;
      nodes.push(asks(id, `key_${i}`));
      edges.push({ from: previous, to: id });
      previous = id;
    }
    nodes.push(node("bye", "hangup"));
    edges.push({ from: previous, to: "bye" });
    return graph(nodes, edges);
  };

  it("accepts exactly the limit", () => {
    expect(validateFlow(chainOf(MAX_FLOW_FIELDS))).toEqual([]);
  });

  it("reports one past the limit against the flow rather than a node", () => {
    const flow = chainOf(MAX_FLOW_FIELDS + 1);

    expect(landsOn(flow, "too-many-fields")).toEqual([null]);
  });
});

describe("edge-to-nowhere", () => {
  it("lands on the step the connection leaves, when the far end is gone", () => {
    const flow = graph([node("s", "start"), node("bye", "hangup")], [
      { from: "s", to: "bye" },
      { from: "bye", to: "deleted" },
    ]);

    expect(landsOn(flow, "edge-to-nowhere")).toEqual(["bye"]);
  });

  it("lands on the step the connection arrives at, when the near end is gone", () => {
    const flow = graph([node("s", "start"), node("bye", "hangup")], [
      { from: "s", to: "bye" },
      { from: "deleted", to: "bye" },
    ]);

    expect(landsOn(flow, "edge-to-nowhere")).toEqual(["bye"]);
  });

  it("lands on the flow when both ends are gone", () => {
    const flow = graph([node("s", "start"), node("bye", "hangup")], [
      { from: "s", to: "bye" },
      { from: "gone", to: "also-gone" },
    ]);

    expect(landsOn(flow, "edge-to-nowhere")).toEqual([null]);
  });

  it("does not count a dangling connection as a way out of a step", () => {
    // Otherwise a step whose only exit was deleted would look fine and the call would
    // silently stop there.
    const flow = graph([node("s", "start")], [{ from: "s", to: "deleted" }]);

    expect(landsOn(flow, "dead-end")).toEqual(["s"]);
    expect(landsOn(flow, "edge-to-nowhere")).toEqual(["s"]);
  });
});
