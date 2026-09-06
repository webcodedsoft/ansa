import { describe, expect, it } from "vitest";

import { CAMPAIGN_TEMPLATES } from "./campaign-templates";
import { suggestVerdicts } from "./verdicts";

/* Against the real catalogue rather than a fixture, because the claim being tested is about
   the catalogue: that its sets are a good guide to what belongs beside what. If a template
   edit breaks that, this is where it shows. */
const SETS = CAMPAIGN_TEMPLATES.map((template) => template.outcomes);

describe("which verdicts to offer next", () => {
  it("starts from the ones most campaigns share when nothing is chosen", () => {
    const first = suggestVerdicts([], SETS);
    expect(first[0]).toBe("confirmed");
    expect(first).toContain("cancelled");
    expect(first).toHaveLength(8);
  });

  it("follows the set the chosen verdict belongs to", () => {
    // Money campaigns agree on this vocabulary; choosing one word should offer the rest.
    const next = suggestVerdicts(["already paid"], SETS);
    expect(next.slice(0, 4)).toEqual(expect.arrayContaining(["will pay", "cannot pay", "disputes"]));
  });

  it("never offers what is already there, whatever the case", () => {
    const next = suggestVerdicts(["Confirmed", "declined "], SETS);
    expect(next).not.toContain("confirmed");
    expect(next).not.toContain("declined");
  });

  it("offers nothing from nothing", () => {
    expect(suggestVerdicts(["confirmed"], [])).toEqual([]);
  });
});
