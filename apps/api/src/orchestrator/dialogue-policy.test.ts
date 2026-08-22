import { describe, expect, it } from "vitest";

import type { EmotionalRead } from "../conversation/emotional-read";
import { computeConstraints, type DialogueState } from "./dialogue-policy";

/**
 * The layer removes options and never chooses words.
 *
 * So the tests are about when it fires and — more importantly — when it does not. Disarming
 * an agent that was about to help somebody is the expensive direction: plenty of angry
 * callers get their problem solved by the agent that annoyed them.
 */

const read = (over: Partial<EmotionalRead> = {}): EmotionalRead => ({
  emotion: "calm",
  energy: "normal",
  trust: "normal",
  urgency: "normal",
  ...over,
});

const state = (over: Partial<DialogueState> = {}): DialogueState => ({
  failedTurns: 0,
  escalationOffered: false,
  read: null,
  contactsThisWeek: 0,
  ...over,
});

describe("leaving a working call alone", () => {
  it("permits everything on an ordinary turn", () => {
    const c = computeConstraints(state());
    expect(c.escalationRequired).toBe(false);
    // Null, not a list: the registry decides what exists and this does not duplicate it.
    expect(c.allowedTools).toBeNull();
  });

  it("does not disarm an agent over one bad turn", () => {
    // Turns go nowhere for ordinary reasons. One is a bad line, not a failing call.
    expect(computeConstraints(state({ failedTurns: 1 })).escalationRequired).toBe(false);
  });

  it("does not disarm it for anger alone", () => {
    /* The expensive direction. Plenty of angry callers get helped by the agent that
       annoyed them, and taking its tools away guarantees it cannot. */
    expect(
      computeConstraints(state({ read: read({ emotion: "angry" }) })).escalationRequired,
    ).toBe(false);
  });

  it("does not disarm it for low trust alone", () => {
    expect(computeConstraints(state({ read: read({ trust: "low" }) })).escalationRequired).toBe(
      false,
    );
  });

  it("does not disarm it on a second call in a week", () => {
    expect(computeConstraints(state({ contactsThisWeek: 2 })).escalationRequired).toBe(false);
  });
});

describe("taking the tools away", () => {
  it("fires the turn before the hard rule transfers", () => {
    /* The watch transfers at three. This is two — the turn where the agent can still hand
       over gracefully rather than being cut off mid-sentence. */
    const c = computeConstraints(state({ failedTurns: 2 }));
    expect(c.escalationRequired).toBe(true);
    expect(c.reason).toContain("gone nowhere");
  });

  it("fires when they are angry and have stopped believing the answers", () => {
    // Together, unlike either alone: somebody who has decided this is not working.
    const c = computeConstraints(state({ read: read({ emotion: "angry", trust: "low" }) }));
    expect(c.escalationRequired).toBe(true);
  });

  it("fires on resignation, which reads as calm and is not", () => {
    /* The most missed signal there is — flat, stopped pushing, given up on you. Enforced
       here precisely because it is the one a person would not notice. */
    expect(computeConstraints(state({ read: read({ emotion: "resigned" }) })).escalationRequired).toBe(
      true,
    );
  });

  it("fires on the fourth call in a week", () => {
    // Three contacts is a failed process, not a difficult caller.
    const c = computeConstraints(state({ contactsThisWeek: 3 }));
    expect(c.escalationRequired).toBe(true);
    expect(c.reason).toContain("3 times this week");
  });

  it("leaves the caller a way out and a way to a person", () => {
    /* Everything else goes. `end_call` stays because somebody saying goodbye mid-collapse
       should be able to hang up cleanly rather than be held on a disarmed line. */
    const c = computeConstraints(state({ failedTurns: 2 }));
    expect(c.allowedTools).toEqual(["transfer_to_human", "end_call"]);
  });

  it("gives the most specific true reason when several hold", () => {
    // "They have called four times this week" tells a reviewer more than "they are angry".
    const c = computeConstraints(
      state({ contactsThisWeek: 4, failedTurns: 3, read: read({ emotion: "angry", trust: "low" }) }),
    );
    expect(c.reason).toContain("4 times this week");
  });
});
