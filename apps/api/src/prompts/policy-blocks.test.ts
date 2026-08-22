import { describe, expect, it } from "vitest";

import { composeSystemPrompt } from "./compose";
import { renderPolicyBlocks, toPolicyBlocks, type PolicyBlock } from "./policy-blocks";

/**
 * The structural half of 8g. Its behavioural half — never reason from one policy to another
 * by analogy — already applies to an organisation's prose; this gives the rules a shape, so
 * that "there is no rule for this" is a thing the model can actually determine rather than
 * a judgement it resolves in favour of having an answer.
 */

const block = (over: Partial<PolicyBlock> = {}): PolicyBlock => ({
  name: "Refunds",
  applies: "they want money back",
  canDo: ["log a refund request"],
  cannotDo: ["approve a refund"],
  escalateWhen: ["they ask how much"],
  ...over,
});

describe("reading what was stored", () => {
  it("takes well-formed blocks", () => {
    expect(toPolicyBlocks([block()])).toHaveLength(1);
  });

  it("returns nothing for an organisation that wrote none", () => {
    // Every organisation, until one does. An agent with none behaves exactly as before.
    expect(toPolicyBlocks(null)).toEqual([]);
    expect(toPolicyBlocks([])).toEqual([]);
  });

  it("drops a block with no name rather than rendering a heading-less rule", () => {
    /* This is the call path and the column is jsonb: rows written by an older schema, or
       by a script, reach here as readily as ones the API validated. */
    expect(toPolicyBlocks([{ applies: "x", canDo: [] }])).toEqual([]);
    expect(toPolicyBlocks([{ name: "   ", applies: "x" }])).toEqual([]);
  });

  it("survives a shape it has never seen", () => {
    // A malformed row must not take a call down on the way to composing its prompt.
    expect(() => toPolicyBlocks("not an array")).not.toThrow();
    expect(toPolicyBlocks([42, null, "x"])).toEqual([]);
    expect(toPolicyBlocks([{ name: "Refunds", applies: "x", canDo: "not a list" }])[0]?.canDo).toEqual([]);
  });
});

describe("what the model reads", () => {
  it("renders nothing at all when there are none", () => {
    expect(renderPolicyBlocks([])).toBe("");
  });

  it("gives each policy a heading it can search for", () => {
    const text = renderPolicyBlocks([block(), block({ name: "Late delivery" })]);
    expect(text).toContain("## Refunds");
    expect(text).toContain("## Late delivery");
  });

  it("keeps what it may do apart from what it may not", () => {
    /* Not negations inside one list: a refusal the agent explains and a handover to a
       person have different consequences, and a model asked to infer which from a sentence
       gets it wrong in the direction that keeps the call. */
    const text = renderPolicyBlocks([block()]);
    expect(text).toContain("You can: log a refund request");
    expect(text).toContain("You cannot: approve a refund");
    expect(text).toContain("Get them a person if: they ask how much");
  });

  it("forbids reasoning from one policy to another", () => {
    /* The line that stops a refund policy becoming an exchange policy — and the reason
       having headings matters, because it is only checkable against discrete rules. */
    const text = renderPolicyBlocks([block()]);
    expect(text).toContain("do not have a policy for it");
    expect(text).toContain("not examples of a pattern");
    expect(text).toContain("get them a person");
  });

  it("states that rule after the policies, not before them", () => {
    // Nothing an organisation wrote may sit downstream of the limit on what they wrote.
    const text = renderPolicyBlocks([block()]);
    expect(text.indexOf("not examples of a pattern")).toBeGreaterThan(text.indexOf("## Refunds"));
  });
});

describe("reaching the prompt", () => {
  it("appears in a composed prompt when an organisation has them", () => {
    const prompt = composeSystemPrompt({ organization: null, tools: [], policyBlocks: [block()] });
    expect(prompt).toContain("## Refunds");
  });

  it("changes nothing for an organisation that has none", () => {
    // Byte for byte the prompt every call had before this existed.
    expect(composeSystemPrompt({ organization: null, tools: [], policyBlocks: null })).toBe(
      composeSystemPrompt({ organization: null, tools: [] }),
    );
  });
});
