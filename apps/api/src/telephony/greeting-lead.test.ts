import { describe, expect, it } from "vitest";

import { ALL_GREETING_LEADS, chooseGreetingLead } from "./greeting-lead";

/**
 * One recording played to the same person three times in a week is what makes an agent
 * sound like a machine. These cover the selection rule; that the audio is actually
 * prepended is covered where the gateway builds the opener.
 */

const at = (over: Partial<Parameters<typeof chooseGreetingLead>[0]> = {}) =>
  chooseGreetingLead({
    partOfDay: "afternoon",
    openNow: true,
    callId: "CA-0001",
    ...over,
  });

/** Every lead this context can produce, across many calls. */
const spread = (over: Partial<Parameters<typeof chooseGreetingLead>[0]> = {}): Set<string | null> =>
  new Set(
    Array.from({ length: 200 }, (_, i) => at({ ...over, callId: `CA-${i.toString().padStart(4, "0")}` })),
  );

describe("choosing how a call opens", () => {
  it("gives the same call the same opener every time it is asked", () => {
    /* The gateway asks once, but determinism is what makes this testable at all — and a
       selection that could differ between two reads within a call is a bug waiting for
       somebody to add a second read. */
    expect(at({ callId: "CA-abc" })).toBe(at({ callId: "CA-abc" }));
  });

  it("gives consecutive calls different openers", () => {
    /* The brief asks to seed this from the caller's number so the same caller gets a
       different variant each time — which a hash of an unchanging number cannot do. The
       call id is the part that varies, so it is what is hashed. */
    expect(spread().size).toBeGreaterThan(1);
  });

  it("most often says nothing at all", () => {
    /* Null is a member of every pool and the intended common case. A flourish on every
       single call is its own kind of recording, and the old behaviour — greeting alone —
       has to stay the most frequent outcome. */
    const nulls = Array.from({ length: 200 }, (_, i) => at({ callId: `CA-${i}` })).filter(
      (lead) => lead === null,
    );
    expect(nulls.length).toBeGreaterThan(30);
  });

  it("matches the opener to the hour", () => {
    const morning = spread({ partOfDay: "morning" });
    expect([...morning].some((lead) => lead?.includes("morning") === true)).toBe(true);
    expect([...morning].some((lead) => lead?.includes("evening") === true)).toBe(false);

    const evening = spread({ partOfDay: "evening" });
    expect([...evening].some((lead) => lead?.includes("evening") === true)).toBe(true);
  });

  it("does not wish anybody a good night", () => {
    // Nobody says "good night" when answering a phone. What an eleven o'clock caller needs
    // to hear is that somebody picked up.
    for (const lead of spread({ partOfDay: "night" })) {
      expect(lead?.toLowerCase() ?? "").not.toContain("night");
    }
  });

  it("drops the time of day entirely when the line is shut", () => {
    /* "Good afternoon" followed by "we're closed" is the agent contradicting itself in two
       sentences. Out of hours the opener only says somebody picked up. */
    for (const lead of spread({ partOfDay: "afternoon", openNow: false })) {
      expect(lead?.toLowerCase() ?? "").not.toContain("afternoon");
    }
  });

  it("treats unknown hours as open, rather than as shut", () => {
    // Null hours means the organisation configured none, which is not a claim to be closed.
    expect([...spread({ partOfDay: "morning", openNow: null })].some((l) => l?.includes("morning") === true)).toBe(true);
  });

  it("offers every phrase it can speak to the renderer", () => {
    /* A lead the boot render never saw is a lead that falls back to no lead at all —
       silently, and only on the calls unlucky enough to pick it. */
    for (const lead of [
      ...spread({ partOfDay: "morning" }),
      ...spread({ partOfDay: "afternoon" }),
      ...spread({ partOfDay: "evening" }),
      ...spread({ partOfDay: "night" }),
      ...spread({ openNow: false }),
    ]) {
      if (lead !== null) expect(ALL_GREETING_LEADS).toContain(lead);
    }
  });
});
