import { describe, expect, it } from "vitest";

import { asksAfterYou, COURTESY_REPLIES, withCourtesy } from "./courtesy";

/**
 * From the call at 17:32 on 2026-08-23, where the caller said "Hi. Good evening. My name is
 * Sikir. How are you doing?" and the agent answered "Sikir — have I got that right?".
 */
describe("noticing that the caller asked after you", () => {
  it("hears it inside a sentence, which is the only place it ever is", () => {
    expect(asksAfterYou("Hi. Good evening. My name is Sikir. How are you doing?")).toBe(true);
  });

  it("hears the Nigerian forms", () => {
    for (const said of ["How far?", "How you dey?", "Abeg how body?"]) {
      expect(asksAfterYou(said), said).toBe(true);
    }
  });

  it("hears it on its own", () => {
    expect(asksAfterYou("how are you")).toBe(true);
  });

  it("does not hear a bare greeting", () => {
    /* The greeting has already been spoken. Answering "good evening" with "good evening"
       is the double-greeting the prompt spends a rule forbidding. */
    for (const said of ["Good evening.", "Hello.", "Hi there."]) {
      expect(asksAfterYou(said), said).toBe(false);
    }
  });

  it("does not hear the caller talking about themselves", () => {
    for (const said of [
      "I am not well at all, that is why I am calling",
      "How much are the flats?",
      "How do I book a viewing?",
    ]) {
      expect(asksAfterYou(said), said).toBe(false);
    }
  });
});

describe("answering without losing the turn", () => {
  it("puts the courtesy in front of what the turn was already going to say", () => {
    expect(withCourtesy("I'm well, thank you.", "Sikiru — have I got that right?")).toBe(
      "I'm well, thank you. Sikiru — have I got that right?",
    );
  });

  it("offers more than one wording, so it cannot become a catchphrase", () => {
    /* `variation.ts` tells the model never to let a phrase become its signature. A single
       string generated in code would be exactly that, said to every caller who ever asks. */
    expect(new Set(COURTESY_REPLIES).size).toBeGreaterThan(2);
  });

  it("keeps every wording short enough to sit in front of a readback", () => {
    for (const reply of COURTESY_REPLIES) {
      expect(reply.split(" ").length, reply).toBeLessThanOrEqual(5);
      expect(reply.trimEnd().endsWith("."), reply).toBe(true);
    }
  });
});
