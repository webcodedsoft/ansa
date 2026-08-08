import { describe, expect, it } from "vitest";

import type { CallerAction } from "./action";
import { budgetFor, budgetMs } from "./turn-budget";

const ALL: readonly CallerAction[] = [
  "polar",
  "wh",
  "explanation",
  "readback",
  "troubles",
  "greeting",
  "closing",
  "statement",
];

describe("budgetFor", () => {
  // The whole point: a yes/no question and a request for an explanation must not get
  // the same allowance.
  it("gives an explanation far more room than a yes/no answer", () => {
    expect(budgetFor("explanation").maxWords).toBeGreaterThan(
      budgetFor("polar").maxWords * 3,
    );
  });

  it("holds every category except explanation to a single sentence or two", () => {
    for (const action of ALL) {
      if (action === "explanation") continue;
      expect(budgetFor(action).maxUnits).toBeLessThanOrEqual(2);
    }
  });

  // A tight token cap guillotines mid-clause and the caller hears a cut-off word. Words
  // are the control; tokens only stop a runaway.
  it("leaves the token guard well clear of the word budget", () => {
    for (const action of ALL) {
      const b = budgetFor(action);
      expect(b.maxTokens).toBeGreaterThan(b.maxWords * 2);
    }
  });

  it("gives every action a usable instruction", () => {
    for (const action of ALL) {
      expect(budgetFor(action).instruction.length).toBeGreaterThan(20);
    }
  });

  it("keeps short answers under about three seconds of speech", () => {
    for (const action of ["polar", "closing", "greeting", "troubles"] as const) {
      expect(budgetMs(budgetFor(action), 15)).toBeLessThan(4500);
    }
  });

  it("scales the estimate with the measured speaking rate", () => {
    const slow = budgetMs(budgetFor("statement"), 10);
    const fast = budgetMs(budgetFor("statement"), 20);
    expect(slow).toBeGreaterThan(fast);
  });
});
