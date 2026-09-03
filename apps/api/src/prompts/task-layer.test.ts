import { describe, expect, it } from "vitest";

import { KNOWLEDGE_TOOL_NAME } from "../orchestrator/knowledge";
import type { CollectedField } from "../tenancy/captured-fields";
import { taskLayer, type AvailableTool } from "./task-layer";

const tool = (name: string, riskTier: AvailableTool["riskTier"] = "read"): AvailableTool => ({
  name,
  description: `what ${name} does`,
  riskTier,
});

const KNOWLEDGE = tool(KNOWLEDGE_TOOL_NAME);

const field = (): CollectedField => ({
  key: "callbackNumber",
  type: "phone",
  prompt: "",
  capture: "either",
  confirm: "readback",
  required: true,
  pattern: "",
  attempts: 3,
  options: [],
});

/**
 * Phrases from the grounding section, quoted rather than paraphrased. A test that asserted
 * on the word "knowledge" would pass on a sentence that told the model to search and never
 * said what to do when the search came back empty, which is the half that matters.
 */
const GROUNDING = [
  "One of those searches what the organisation has actually written down.",
  "Say only what came back.",
  "If it comes back with nothing, say plainly that you don't have that and offer to put",
  "Never fill the gap yourself.",
];

describe("the tool list", () => {
  it("names each tool with what happens when the model asks for it", () => {
    const layer = taskLayer([tool("business_hours"), tool("update_contact_number", "write")]);

    expect(layer).toContain("- business_hours: what business_hours does (runs straight away)");
    expect(layer).toContain("only after you've said it back and they've agreed");
  });

  it("says plainly that nothing can be looked up when nothing is registered", () => {
    expect(taskLayer([])).toContain("You can't look anything up on this call.");
  });
});

describe("grounding", () => {
  it("tells an agent with a knowledge base to answer from it and nowhere else", () => {
    const layer = taskLayer([KNOWLEDGE, tool("end_call")]);

    for (const line of GROUNDING) expect(layer).toContain(line);
  });

  it("mentions no knowledge base to an agent that has none", () => {
    // The whole requirement in one assertion. `search_knowledge_base` is only registered
    // when the agent has sources, so its absence from the list is the absence of sources —
    // and an agent told to ground itself in a store nobody attached would refuse to answer
    // questions it could have answered from its own instructions.
    const layer = taskLayer([tool("end_call"), tool("business_hours"), tool("transfer_to_human")]);

    for (const line of GROUNDING) expect(layer).not.toContain(line);
    expect(layer.toLowerCase()).not.toContain("knowledge");
    expect(layer.toLowerCase()).not.toContain("written down");
    expect(layer).not.toContain("search");
  });

  it("mentions no knowledge base when no tool is registered at all", () => {
    const layer = taskLayer([]);

    for (const line of GROUNDING) expect(layer).not.toContain(line);
    expect(layer.toLowerCase()).not.toContain("knowledge");
  });

  it("keys off the name the tool is actually registered under", () => {
    // The two files agree on one string. If the definition is renamed and this is not, the
    // instruction silently stops being composed and the agent starts improvising again —
    // a failure with no error and no log line.
    const layer = taskLayer([tool("search_knowledge_base")]);

    expect(layer).toContain("Say only what came back.");
  });

  it("does not go looking for the name inside a description", () => {
    const layer = taskLayer([
      { name: "policy_lookup", description: `not the ${KNOWLEDGE_TOOL_NAME} tool`, riskTier: "read" },
    ]);

    for (const line of GROUNDING) expect(layer).not.toContain(line);
  });
});

describe("composition", () => {
  it("puts the grounding before the form, so the last thing asked for is the first thing done", () => {
    const layer = taskLayer([KNOWLEDGE], [field()]);

    expect(layer.indexOf("Never fill the gap yourself.")).toBeLessThan(
      layer.indexOf("There are things you need from them on this call."),
    );
  });

  it("still composes the form for an agent with a knowledge base", () => {
    const layer = taskLayer([KNOWLEDGE], [field()]);

    expect(layer).toContain("- callbackNumber: ask for their callback number");
    expect(layer).toContain("Say only what came back.");
  });

  it("keeps the tool list, the grounding and the form as separate paragraphs", () => {
    const layer = taskLayer([KNOWLEDGE], [field()]);

    // Blank lines are what stop the model reading the form's numbered instructions as part
    // of the grounding rule.
    expect(layer.split("\n\n")).toHaveLength(3);
  });
});
