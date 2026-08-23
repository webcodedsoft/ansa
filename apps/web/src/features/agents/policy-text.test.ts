import { describe, expect, it } from "vitest";

import type { PolicyBlock } from "./components/policy-tab";
import { parsePolicies, renderPolicies, samePolicies } from "./policy-text";

/**
 * The property the swap button rests on.
 *
 * A toggle between two editors is only safe if going one way and back leaves the work
 * untouched. Everything else here is detail; the round trip is the feature, so it is tested
 * against the awkward cases rather than a tidy one — punctuation that looks like syntax, an
 * empty list, a policy with nothing in it at all.
 *
 * The failure this guards is specific and silent: somebody types a sentence in the document
 * view, presses the button, and the sentence is gone because it sat somewhere the parser did
 * not look. So the parser reports what it could not place, and these check the report as
 * carefully as the result.
 */

const REFUNDS: PolicyBlock = {
  name: "Refunds",
  applies: "The caller wants money back for something they have already paid for.",
  canDo: ["Issue a refund within 14 days", "Explain the refund timeline"],
  cannotDo: ["Promise a date finance has not given"],
  escalateWhen: ["The amount is over ₦50,000"],
};

const CANCELLATIONS: PolicyBlock = {
  name: "Cancellations",
  applies: "The caller wants to stop a policy before it renews.",
  canDo: ["Cancel from the next cycle"],
  cannotDo: [],
  escalateWhen: [],
};

describe("a policy document", () => {
  it("survives being rendered and read back", () => {
    const { blocks, problems } = parsePolicies(renderPolicies([REFUNDS, CANCELLATIONS]));
    expect(problems).toEqual([]);
    expect(samePolicies(blocks, [REFUNDS, CANCELLATIONS])).toBe(true);
  });

  it("survives a policy with nothing in it", () => {
    /* The state every new policy starts in. If the empty case does not round-trip, adding one
       and swapping view loses it — which is the first thing anybody would do. */
    const empty: PolicyBlock = {
      name: "Untitled",
      applies: "",
      canDo: [],
      cannotDo: [],
      escalateWhen: [],
    };
    const { blocks, problems } = parsePolicies(renderPolicies([empty]));
    expect(problems).toEqual([]);
    expect(samePolicies(blocks, [empty])).toBe(true);
  });

  it("keeps punctuation that looks like syntax", () => {
    /* A dash inside a sentence must not read as a list marker, and a hash inside one must not
       start a policy. Only a line that *begins* with them counts. */
    const tricky: PolicyBlock = {
      name: "Refunds — partial",
      applies: "They paid but did not receive everything.",
      canDo: ["Refund the part that did not arrive - not the whole order", "Use #REF as the note"],
      cannotDo: [],
      escalateWhen: [],
    };
    const { blocks, problems } = parsePolicies(renderPolicies([tricky]));
    expect(problems).toEqual([]);
    expect(samePolicies(blocks, [tricky])).toBe(true);
  });

  it("writes empty headings out rather than omitting them", () => {
    /* Otherwise somebody with no "Must not" has nowhere to type the first one, and would have
       to know the heading exists. */
    const text = renderPolicies([CANCELLATIONS]);
    expect(text).toContain("Must not");
    expect(text).toContain("Hand over when");
  });
});

describe("what the parser refuses to guess at", () => {
  it("reports a line that sits under no heading", () => {
    const { problems } = parsePolicies(["## Refunds", "", "Do the thing"].join("\n"));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.line).toBe(3);
    expect(problems[0]?.message).toContain("under no heading");
  });

  it("reports text above the first policy instead of dropping it", () => {
    /* Usually somebody's note to themselves. Swallowing it is exactly the silent loss the
       swap button must never cause. */
    const { problems } = parsePolicies(["remember to ask legal", "", "## Refunds"].join("\n"));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.line).toBe(1);
  });

  it("reports a policy with no name", () => {
    const { problems } = parsePolicies(["##", "", "Applies when", "something"].join("\n"));
    expect(problems.some((problem) => problem.message.includes("no name"))).toBe(true);
  });
});

describe("reading a document somebody typed by hand", () => {
  it("takes a list line without its dash", () => {
    const { blocks, problems } = parsePolicies(
      ["## Refunds", "Applies when", "they want money back", "Can", "Issue a refund"].join("\n"),
    );
    expect(problems).toEqual([]);
    expect(blocks[0]?.canDo).toEqual(["Issue a refund"]);
  });

  it("does not care how the headings are capitalised", () => {
    const { blocks, problems } = parsePolicies(
      ["## Refunds", "APPLIES WHEN", "they want money back", "can", "- Issue a refund"].join("\n"),
    );
    expect(problems).toEqual([]);
    expect(blocks[0]?.applies).toBe("they want money back");
    expect(blocks[0]?.canDo).toEqual(["Issue a refund"]);
  });

  it("joins an applies-clause wrapped across two lines", () => {
    const { blocks } = parsePolicies(
      ["## Refunds", "Applies when", "they want money back", "for something already paid"].join(
        "\n",
      ),
    );
    expect(blocks[0]?.applies).toBe("they want money back for something already paid");
  });
});
