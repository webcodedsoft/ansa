import { describe, expect, it } from "vitest";

import {
  flowStatusLine,
  flowSummary,
  orderProblems,
  plural,
  stepLabel,
  type FlowProblemLike,
  type FlowStepLike,
} from "./flow-problems";

/**
 * The problem strip, tested where it can be: the pure half.
 *
 * There is no DOM library in this app on purpose, and `jsx: "preserve"` means a test cannot
 * import a `.tsx` at all, so nothing here renders. What is worth asserting anyway is everything that decides what the operator reads
 * and in what order — the queue, the names, and the verdict line — and none of that needs a
 * browser.
 *
 * The steps are written in canvas order, because that is what `orderProblems` sorts by and a
 * fixture in a different order would pass for the wrong reason.
 */

const step = (id: string, kind: FlowStepLike["kind"], rest: Partial<FlowStepLike> = {}): FlowStepLike => ({
  id,
  kind,
  ...rest,
});

const problem = (
  nodeId: string | null,
  code: string,
  blocking: boolean,
  message = "something happens to the caller",
): FlowProblemLike => ({ nodeId, code, message, blocking });

const STEPS: readonly FlowStepLike[] = [
  step("n1", "start"),
  step("n2", "say", { text: "Good afternoon, Kano General Insurance." }),
  step("n3", "collect", { field: { key: "policyNumber" } }),
  step("n4", "decide", { on: "reason" }),
  step("n5", "hangup"),
];

describe("what the operator reads first", () => {
  it("puts blocking problems above warnings whatever order they arrive in", () => {
    const ordered = orderProblems(
      [
        problem("n2", "unreachable", false),
        problem("n4", "decide-without-otherwise", true),
        problem("n3", "duplicate-field-key", false),
        problem("n5", "dead-end", true),
      ],
      STEPS,
    );

    expect(ordered.map((entry) => entry.problem.code)).toEqual([
      "decide-without-otherwise",
      "dead-end",
      "unreachable",
      "duplicate-field-key",
    ]);
    expect(ordered.map((entry) => entry.problem.blocking)).toEqual([true, true, false, false]);
  });

  it("walks the call within a group rather than the order the validator emitted", () => {
    const ordered = orderProblems(
      [problem("n5", "dead-end", true), problem("n2", "unreachable", true), problem("n3", "collect-without-field", true)],
      STEPS,
    );

    expect(ordered.map((entry) => entry.problem.nodeId)).toEqual(["n2", "n3", "n5"]);
  });

  it("floats problems about the whole graph to the head of their group", () => {
    const ordered = orderProblems(
      [problem("n3", "collect-without-field", true), problem(null, "no-start", true)],
      STEPS,
    );

    expect(ordered.map((entry) => entry.problem.code)).toEqual(["no-start", "collect-without-field"]);
    expect(ordered[0]?.step).toBeNull();
  });

  it("keeps the validator's order for two problems on one step", () => {
    const ordered = orderProblems(
      [problem("n3", "duplicate-field-key", true), problem("n3", "collect-without-field", true)],
      STEPS,
    );

    expect(ordered.map((entry) => entry.problem.code)).toEqual([
      "duplicate-field-key",
      "collect-without-field",
    ]);
  });

  it("resolves each problem to the step it belongs to", () => {
    const [entry] = orderProblems([problem("n3", "dead-end", true)], STEPS);

    expect(entry?.step?.id).toBe("n3");
  });

  /* A node id the canvas no longer has cannot be focused, so it has to fall back to the
     whole-flow row — a clickable entry that selects nothing is worse than a plain one. */
  it("treats a problem naming a step that is gone as a whole-flow problem", () => {
    const [entry] = orderProblems([problem("n99", "edge-to-nowhere", true)], STEPS);

    expect(entry?.step).toBeNull();
  });

  it("has nothing to show when the graph is clean", () => {
    expect(orderProblems([], STEPS)).toEqual([]);
  });
});

describe("naming a step so somebody can find it", () => {
  it("names each kind after what it does on the call", () => {
    expect(stepLabel(step("n1", "start"))).toBe("Call answered");
    expect(stepLabel(step("n3", "collect", { field: { key: "policyNumber" } }))).toBe("Asks for policyNumber");
    expect(stepLabel(step("n4", "decide", { on: "reason" }))).toBe("Branches on reason");
    expect(stepLabel(step("n6", "confirm", { on: "amount" }))).toBe("Confirms amount");
    expect(stepLabel(step("n7", "tool", { tool: "policy_lookup" }))).toBe("Calls policy_lookup");
    expect(stepLabel(step("n8", "transfer"))).toBe("Transfers to a person");
    expect(stepLabel(step("n9", "hangup"))).toBe("Ends the call");
  });

  it("quotes enough of a say step to tell two of them apart", () => {
    expect(stepLabel(step("n2", "say", { text: "Thanks for holding." }))).toBe("Says “Thanks for holding.”");
  });

  it("clips a long line rather than letting it run the width of the strip", () => {
    const label = stepLabel(
      step("n2", "say", { text: "Good afternoon, you have reached Kano General Insurance." }),
    );

    expect(label).toBe("Says “Good afternoon, you have reached…”");
  });

  it("flattens the whitespace a pasted line brings with it", () => {
    expect(stepLabel(step("n2", "say", { text: "  Hello\n  there  " }))).toBe("Says “Hello there”");
  });

  /* The half-built steps are exactly the ones a problem points at, so the fallback name is
     load-bearing rather than defensive. It must never restate the problem. */
  it("still names a step that has not been filled in", () => {
    expect(stepLabel(step("n2", "say"))).toBe("Says something");
    expect(stepLabel(step("n2", "say", { text: "   " }))).toBe("Says something");
    expect(stepLabel(step("n3", "collect"))).toBe("Asks a question");
    expect(stepLabel(step("n4", "decide"))).toBe("Branches");
    expect(stepLabel(step("n6", "confirm"))).toBe("Confirms a value");
    expect(stepLabel(step("n7", "tool"))).toBe("Calls a tool");
  });
});

describe("the line that says whether it could answer a phone", () => {
  it("leads with the blocking count and says a publish would be refused", () => {
    const line = flowStatusLine(STEPS, [problem("n4", "decide-without-otherwise", true)]);

    expect(line.tone).toBe("bad");
    expect(line.label).toBe("1 problem · cannot publish");
  });

  it("counts only the blocking ones when both kinds are present", () => {
    const line = flowStatusLine(STEPS, [
      problem("n4", "decide-without-otherwise", true),
      problem("n5", "dead-end", true),
      problem("n2", "unreachable", false),
    ]);

    expect(line.label).toBe("2 problems · cannot publish");
  });

  it("shows warnings on their own without claiming the flow cannot publish", () => {
    const line = flowStatusLine(STEPS, [problem("n2", "unreachable", false)]);

    expect(line.tone).toBe("warn");
    expect(line.label).toBe("1 warning");
  });

  it("says so plainly when there is nothing wrong", () => {
    const line = flowStatusLine(STEPS, []);

    expect(line.tone).toBe("ok");
    expect(line.label).toBe("ready to publish");
  });

  /* The summary is present in every state, including the bad one: knowing there is one
     problem is not the same as knowing how big the thing holding it is. */
  it("carries the summary alongside the verdict whatever the verdict is", () => {
    expect(flowStatusLine(STEPS, []).summary).toBe("5 steps · 1 question · 1 branch");
    expect(flowStatusLine(STEPS, [problem(null, "no-start", true)]).summary).toBe(
      "5 steps · 1 question · 1 branch",
    );
  });
});

describe("counting what is on the canvas", () => {
  it("counts every card, the start included, so it matches what is on screen", () => {
    expect(flowSummary(STEPS)).toBe("5 steps · 1 question · 1 branch");
  });

  it("leaves out what the flow does not have rather than showing a zero", () => {
    expect(flowSummary([step("n1", "start"), step("n5", "hangup")])).toBe("2 steps");
  });

  it("pluralises branches the way English does", () => {
    const branches = [step("n1", "decide", { on: "a" }), step("n2", "decide", { on: "b" })];

    expect(flowSummary(branches)).toBe("2 steps · 2 branches");
  });

  it("says nothing at all is there when nothing is", () => {
    expect(flowSummary([])).toBe("0 steps");
  });

  it("agrees with itself on one", () => {
    expect(plural(1, "problem")).toBe("1 problem");
    expect(plural(0, "problem")).toBe("0 problems");
    expect(plural(1, "branch", "branches")).toBe("1 branch");
  });
});
