import { describe, expect, it } from "vitest";

import {
  flowAllowsTool,
  namedInternalTools,
  GATED_INTERNAL_TOOLS,
  type Flow,
  type FlowNode,
} from "./index";

/**
 * Which internal tools a drawing has to name before a call gets them.
 *
 * Four are gated and six are not, and the split is not about danger — it is about whether the
 * tool is a step somebody draws or machinery every call needs. The tests that matter here are
 * the two ways this goes wrong: gating something the engine needs, so flows silently stop
 * capturing; and reading only `.tool`, so a transfer step loses the tool that performs it.
 */

const node = (id: string, kind: string, tool?: string): FlowNode =>
  ({ id, kind, x: 0, y: 0, ...(tool === undefined ? {} : { tool }) }) as FlowNode;

const flowOf = (...nodes: readonly FlowNode[]): Flow => ({ version: 1, nodes: [...nodes], edges: [] });

describe("what a drawing names", () => {
  it("reads a tool step's own name", () => {
    const named = namedInternalTools(flowOf(node("a", "tool", "book_appointment")));
    expect(named?.has("book_appointment")).toBe(true);
  });

  it("counts a transfer step as naming the transfer tool", () => {
    /* A transfer is its own node kind, not a tool node with `tool` set — `flow-form` walks to
       `{ kind: "transfer" }`. Reading only `.tool` would take the tool away from every flow
       that draws a transfer, which is the feature failing on its commonest use. */
    const named = namedInternalTools(flowOf(node("t", "transfer")));
    expect(named?.has("transfer_to_human")).toBe(true);
  });

  it("ignores a tool node with nothing chosen yet", () => {
    const named = namedInternalTools(flowOf(node("a", "tool", "   "), node("b", "tool")));
    expect(named?.size).toBe(0);
  });

  it("says null for an agent that is not a drawing at all", () => {
    /* Null, not an empty set. "Named nothing" and "has no way to name anything" must not
       collapse: a form-authored agent has no nodes, and gating it would take all four tools
       off every one of them at once. */
    expect(namedInternalTools(null)).toBeNull();
  });
});

describe("the gate both halves ask", () => {
  it("gates exactly the four, and nothing else", () => {
    expect([...GATED_INTERNAL_TOOLS].sort()).toEqual([
      "book_appointment",
      "find_appointment_slots",
      "transfer_to_human",
      "transfer_urgently",
    ]);
  });

  it("leaves the engine's own machinery alone", () => {
    /* The six that are not steps. `record_answer` and `confirm_answer` in particular are how
       a captured field is written and read back — gate those and every flow stops collecting
       anything, with no error to say why. */
    const drawn = namedInternalTools(flowOf(node("s", "say")));
    for (const tool of [
      "end_call",
      "confirm_answer",
      "record_answer",
      "record_call_outcome",
      "business_hours",
      "search_knowledge_base",
    ]) {
      expect(flowAllowsTool(drawn, tool), tool).toBe(true);
    }
  });

  it("withholds a gated tool the drawing never mentions", () => {
    const drawn = namedInternalTools(flowOf(node("a", "tool", "find_appointment_slots")));
    expect(flowAllowsTool(drawn, "find_appointment_slots")).toBe(true);
    // Offering times and taking one are separate steps, so naming one does not grant the other.
    expect(flowAllowsTool(drawn, "book_appointment")).toBe(false);
    expect(flowAllowsTool(drawn, "transfer_urgently")).toBe(false);
  });

  it("gates nothing at all for a form-authored agent", () => {
    for (const tool of GATED_INTERNAL_TOOLS) {
      expect(flowAllowsTool(null, tool), tool).toBe(true);
    }
  });
});
