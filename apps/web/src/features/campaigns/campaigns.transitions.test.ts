import { describe, expect, it } from "vitest";

import type { CampaignStatus } from "./campaigns.service";
import { moveLabel, nextStatuses } from "./campaigns.transitions";

/**
 * The console offers only the moves the API allows. This is the mirror; the API is the
 * enforcer. If they drift, a legal move goes missing from the screen or an illegal one is
 * offered and earns a 409 — either is worth a test, because neither shows up in a typecheck.
 */
describe("the moves a campaign may make", () => {
  it("walks the documented path forward", () => {
    expect(nextStatuses("draft")).toContain("scheduled");
    expect(nextStatuses("scheduled")).toContain("running");
    expect(nextStatuses("running")).toContain("paused");
    expect(nextStatuses("paused")).toContain("done");
  });

  it("allows the two documented steps back", () => {
    expect(nextStatuses("scheduled")).toContain("draft");
    expect(nextStatuses("paused")).toContain("running");
  });

  it("offers nothing from a finished campaign", () => {
    expect(nextStatuses("done")).toEqual([]);
  });

  it("never offers a move the chain does not have", () => {
    /* A running campaign may be paused or finished — the API allows both, and this mirror
       used to offer only Pause, so finishing meant a detour nothing explained. Draft still
       cannot jump straight to running. */
    expect(nextStatuses("running")).toContain("paused");
    expect(nextStatuses("running")).toContain("done");
    expect(nextStatuses("draft")).not.toContain("running");
  });

  it("names each move by the act, not the destination", () => {
    expect(moveLabel("draft", "scheduled")).toBe("Schedule");
    expect(moveLabel("scheduled", "running")).toBe("Start calling");
    // Resuming from a pause reads differently from starting for the first time.
    expect(moveLabel("paused", "running")).toBe("Resume");
    expect(moveLabel("running", "paused")).toBe("Pause");
    expect(moveLabel("paused", "done")).toBe("Finish");
    expect(moveLabel("scheduled", "draft")).toBe("Back to draft");
  });

  it("proposes a target the campaign can actually accept", () => {
    // Every offered move must itself be a status the type knows about.
    const known: readonly CampaignStatus[] = ["draft", "scheduled", "running", "paused", "done"];
    for (const from of known) {
      for (const to of nextStatuses(from)) expect(known).toContain(to);
    }
  });
});
