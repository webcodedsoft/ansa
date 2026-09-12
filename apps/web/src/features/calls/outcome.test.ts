import { describe, expect, it } from "vitest";

import { FILTERABLE_OUTCOMES, outcomeOf } from "./outcome";

describe("what a call's end reason is called on screen", () => {
  it("never shows the transport's exit codes", () => {
    /* These are how the socket closed. Real to an engineer, noise to a receptionist — and
       "socket closed with code 1005" beside a caller's name reads as something being broken. */
    for (const raw of [
      "carrier sent stop",
      "socket closed with code 1005",
      "listen socket closed with code 1006",
      "deepgram socket closed with code 1011",
    ]) {
      expect(outcomeOf(raw, true)).toEqual({ label: "ended", tone: "neutral", icon: "ended" });
    }
  });

  it("keeps the outcomes that mean something", () => {
    expect(outcomeOf("completed", true)).toEqual({ label: "completed", tone: "ok", icon: "done" });
    expect(outcomeOf("escalated", true)).toEqual({ label: "handed to a human", tone: "warn", icon: "human" });
    expect(outcomeOf("no-answer", true)).toEqual({ label: "no answer", tone: "warn", icon: "missed" });
    expect(outcomeOf("failed", true)).toEqual({ label: "failed", tone: "bad", icon: "failed" });
    // Plain English already, and neutral: people hang up when they are finished.
    expect(outcomeOf("caller hung up", true)).toEqual({ label: "caller hung up", tone: "neutral", icon: "hung-up" });
  });

  it("says live only while the call is actually up", () => {
    expect(outcomeOf(null, false).label).toBe("live");
    /* An ended call with no reason recorded is "ended", not "live" — which is why callers pass
       whether it ended rather than whether a reason exists. */
    expect(outcomeOf(null, true).label).toBe("ended");
  });

  it("does not guess at a reason it has never seen", () => {
    // A new string nobody has looked at is exactly what should not reach a customer's staff.
    expect(outcomeOf("something the next transport writes", true).label).toBe("ended");
  });

  it("offers only the meaningful outcomes as filters, labelled as the column labels them", () => {
    const values = FILTERABLE_OUTCOMES.map((one) => one.value);
    expect(values).not.toContain("carrier sent stop");
    expect(values).toContain("escalated");
    const escalated = FILTERABLE_OUTCOMES.find((one) => one.value === "escalated");
    expect(escalated?.label).toBe("handed to a human");
  });
});
