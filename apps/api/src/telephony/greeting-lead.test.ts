import { readFileSync } from "node:fs";
import { join } from "node:path";

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
    history: null,
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

describe("greeting somebody who has rung before", () => {
  const rang = (daysAgo: number, lastCallHandedOver = false) => ({
    lastContactDaysAgo: daysAgo,
    lastCallHandedOver,
  });

  it("always says something to a returning caller", () => {
    /* The one place this file spends its variety budget. Greeting somebody who rang
       yesterday exactly as it greets a stranger is the failure the whole feature exists
       for, so there is no blank in that pool. */
    for (let i = 0; i < 40; i += 1) {
      expect(at({ callId: `CA-${i}`, history: rang(1) })).not.toBeNull();
    }
  });

  it("puts that ahead of the time of day", () => {
    /* "Good afternoon" to somebody who rang yesterday about a problem still not fixed is a
       worse opener than no time of day at all. What they need to hear first is that they
       are not starting again. */
    for (const lead of spread({ partOfDay: "morning", history: rang(1) })) {
      expect(lead?.toLowerCase() ?? "").not.toContain("morning");
      // "Welcome back" acknowledges a prior call without the word, so match the sense.
      expect(lead?.toLowerCase() ?? "").toMatch(/again|back/);
    }
  });

  it("puts it ahead of the line being shut, too", () => {
    for (const lead of spread({ openNow: false, history: rang(2) })) {
      expect(lead?.toLowerCase() ?? "").toMatch(/again|back/);
    }
  });

  it("acknowledges the thread when a person took the last call", () => {
    // A different situation the caller can feel: they were handed on and are ringing back.
    const leads = spread({ history: rang(1, true) });
    expect([...leads].some((l) => l?.includes("calling back") === true)).toBe(true);
  });

  it("never guesses what the last call was about", () => {
    /* The log holds a date and whether a person took over. An opener that guessed at the
       subject would be wrong often and confidently, in the first sentence. */
    for (const lead of [...spread({ history: rang(1) }), ...spread({ history: rang(1, true) })]) {
      expect(lead?.toLowerCase() ?? "").not.toMatch(/about|regarding|your (order|claim|policy)/);
    }
  });

  it("treats somebody who rang months ago as new", () => {
    // Rang once, a while back. Not a returning caller in any sense they would recognise.
    const leads = spread({ partOfDay: "morning", history: rang(90) });
    expect([...leads].some((l) => l?.includes("morning") === true)).toBe(true);
    expect([...leads].some((l) => l === null)).toBe(true);
  });

  it("treats a first-time caller as new", () => {
    const leads = spread({ partOfDay: "morning", history: { lastContactDaysAgo: null, lastCallHandedOver: false } });
    expect([...leads].some((l) => l?.includes("morning") === true)).toBe(true);
  });

  it("offers every returning phrase to the renderer as well", () => {
    // A lead the boot render never saw falls back to no lead at all, silently.
    for (const lead of [...spread({ history: rang(1) }), ...spread({ history: rang(1, true) })]) {
      if (lead !== null) expect(ALL_GREETING_LEADS).toContain(lead);
    }
  });
});

/**
 * The returning greeting only exists if the history arrives before the first word.
 *
 * It is read at ingress and collected when the socket opens, which is the same trade
 * `warmForOrganization` already makes — never awaited, because the carrier is waiting for
 * TwiML. A prefetch nobody starts is the whole feature quietly reverting to a stranger's
 * hello, with no error and nothing in a log.
 *
 * Read from source rather than by driving the controller, which is the pattern
 * `numbers/environment.test.ts` uses for the webhook path and for the same reason:
 * instantiating it drags the entire call path in to assert one line.
 */
describe("starting the lookup early enough to matter", () => {
  const source = (name: string): string =>
    readFileSync(join(__dirname, name), "utf8");

  it("is kicked off by the ingress handler, beside the audio warm", () => {
    const controller = source("voice.controller.ts");
    expect(controller).toContain("warmCallerHistory");
    // Never awaited. An await here is time the caller spends listening to ringing.
    expect(controller).not.toMatch(/await\s+this\.media\.warmCallerHistory/);
  });

  it("is collected by the media socket rather than read again there", () => {
    const gateway = source("media.gateway.ts");
    expect(gateway).toContain("takeHistory");
    // Deleted on collection: an entry that lingers is a phone number held in memory for
    // a call that may never have opened a socket.
    expect(gateway).toMatch(/this\.history\.delete/);
  });
});
