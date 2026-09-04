import { describe, expect, it } from "vitest";

import { BASE_KEYTERMS, KEYTERMS_LEFT_FOR_ORGANISATIONS, MAX_KEYTERMS } from "./defaults";

/**
 * The base keyterms are a standing charge against every organisation's hundred.
 *
 * Deepgram silently ignores the whole list past the cap, so the base has to leave room —
 * and the only thing that stops a good idea ("add the banks", "add every state") from
 * eating the organisation's share is a number somebody has to change on purpose.
 */
describe("the transcriber vocabulary every call starts with", () => {
  it("leaves an organisation at least thirty terms of its own", () => {
    expect(KEYTERMS_LEFT_FOR_ORGANISATIONS).toBeGreaterThanOrEqual(30);
    expect(BASE_KEYTERMS.length + KEYTERMS_LEFT_FOR_ORGANISATIONS).toBe(MAX_KEYTERMS);
  });

  it("holds no duplicates, which would spend a slot on nothing", () => {
    const lower = BASE_KEYTERMS.map((term) => term.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it("boosts the places and words a Nigerian caller says on any call", () => {
    for (const term of ["Lagos", "Lekki", "Abuja", "Oga", "wahala"]) {
      expect(BASE_KEYTERMS).toContain(term);
    }
  });
});
