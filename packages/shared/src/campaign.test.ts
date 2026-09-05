import { describe, expect, it } from "vitest";

import { briefIsEditable, campaignLayer, mergeFacts } from "./campaign";

describe("this person's own facts", () => {
  it("fills the placeholders it knows", () => {
    expect(mergeFacts("your viewing at {property} on {when}", { property: "14 Adeola Odeku", when: "Tuesday at 2" }))
      .toBe("your viewing at 14 Adeola Odeku on Tuesday at 2");
  });

  it("leaves an unknown placeholder standing rather than blanking it", () => {
    /* A sentence still holding {when} is a mistake somebody catches on the first test call.
       "your viewing at on" is one nobody notices until a caller hears it. */
    expect(mergeFacts("your viewing at {property} on {when}", { property: "14 Adeola Odeku" }))
      .toBe("your viewing at 14 Adeola Odeku on {when}");
  });

  it("changes nothing when there are no facts at all", () => {
    expect(mergeFacts("your appointment", null)).toBe("your appointment");
    expect(mergeFacts("your appointment", undefined)).toBe("your appointment");
  });
});

describe("what this call is about, as a prompt layer", () => {
  const base = {
    organizationName: "Oakhaven Properties",
    purpose: "to confirm your viewing at {property} on {when}",
    opening: null,
    outcomes: [] as readonly string[],
    facts: { property: "14 Adeola Odeku", when: "Tuesday at 2" },
  };

  it("names the company and the reason, with this person's detail in it", () => {
    const layer = campaignLayer(base);
    expect(layer).toContain("on behalf of Oakhaven Properties");
    expect(layer).toContain("to confirm your viewing at 14 Adeola Odeku on Tuesday at 2");
    // The reason is the whole call, and the layer has to say so.
    expect(layer).toContain("That is the whole reason you rang");
  });

  it("carries an opening when one was written, with facts merged into it too", () => {
    const layer = campaignLayer({ ...base, opening: "I'm ringing about {property}." });
    expect(layer).toContain("I'm ringing about 14 Adeola Odeku.");
  });

  it("says nothing about an opening when none was written", () => {
    expect(campaignLayer(base)).not.toContain("Open with this");
  });

  it("lists the outcomes and refuses to let the agent flatter them", () => {
    const layer = campaignLayer({ ...base, outcomes: ["confirmed", "rescheduled", "declined"] });
    expect(layer).toContain("record_call_outcome");
    expect(layer).toContain("- confirmed");
    expect(layer).toContain("- declined");
    expect(layer).toContain("never guess to make the number");
  });

  it("says nothing about recording when the campaign wants no verdict", () => {
    expect(campaignLayer(base)).not.toContain("record_call_outcome");
  });
});

describe("when the brief may still change", () => {
  it("is editable before anything can be in flight, and not after", () => {
    expect(briefIsEditable("draft")).toBe(true);
    expect(briefIsEditable("scheduled")).toBe(true);
    expect(briefIsEditable("running")).toBe(false);
    // Paused is not editable either: a call placed a moment ago may still be talking.
    expect(briefIsEditable("paused")).toBe(false);
    expect(briefIsEditable("done")).toBe(false);
  });
});
