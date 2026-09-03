import { describe, expect, it } from "vitest";

import { branchCount, questionsFromFlow } from "./flow-questions";
import { FLOW_VERSION, type Flow } from "./flow.schema";

const field = (key: string, type: "choice" | "amount" | "name" = "name") => ({
  key,
  type,
  prompt: `Your ${key}?`,
  capture: "speech" as const,
  confirm: "none" as const,
  pattern: "",
  attempts: 3,
  required: true,
  options: type === "choice" ? ["rent", "buy"] : [],
});

/* start → intent → decide → (rent) budget / (else) deposit → phone → end */
const forked: Flow = {
  version: FLOW_VERSION,
  nodes: [
    { id: "start", kind: "start", x: 0, y: 0 },
    { id: "intent", kind: "collect", x: 1, y: 0, field: field("intent", "choice") },
    { id: "d", kind: "decide", x: 2, y: 0, on: "intent" },
    { id: "budget", kind: "collect", x: 3, y: 0, field: field("budget", "amount") },
    { id: "deposit", kind: "collect", x: 3, y: 9, field: field("deposit", "amount") },
    { id: "phone", kind: "collect", x: 4, y: 0, field: field("phone") },
    { id: "end", kind: "hangup", x: 5, y: 0 },
  ],
  edges: [
    { from: "start", to: "intent" },
    { from: "intent", to: "d" },
    { from: "d", to: "budget", when: { equals: "rent" } },
    { from: "d", to: "deposit", otherwise: true },
    { from: "budget", to: "phone" },
    { from: "deposit", to: "phone" },
    { from: "phone", to: "end" },
  ],
};

describe("the questions a flow asks, as the Data captured tab lists them", () => {
  it("says which branch each question sits behind, and nothing for the ones every call reaches", () => {
    expect(questionsFromFlow(forked).map((q) => [q.key, q.asked])).toEqual([
      ["intent", null],
      ["budget", 'when intent is "rent"'],
      ["deposit", "when intent is anything else"],
      ["phone", null],
    ]);
  });

  it("phrases a threshold with grouping, as the agent would say it", () => {
    const flow: Flow = {
      ...forked,
      nodes: forked.nodes.map((n) => (n.id === "d" ? { ...n, on: "budget" } : n)),
      edges: forked.edges.map((e) =>
        e.from === "d" && e.when !== undefined ? { ...e, when: { greaterThan: 50000 } } : e,
      ),
    };
    // The decide now reads budget before it is asked — the validator's problem, not this
    // function's. The phrasing is what is under test.
    expect(questionsFromFlow(flow).find((q) => q.key === "budget")?.asked).toBe(
      "when budget is more than 50,000",
    );
  });

  it("counts the places a flow branches", () => {
    expect(branchCount(forked)).toBe(1);
  });
});
