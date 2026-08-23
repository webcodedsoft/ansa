import { describe, expect, it } from "vitest";

import { subjectOf } from "./call-records";

/**
 * `subjectOf` alone. Everything else in `readCallerHistory` needs a database and is covered
 * by the suites that have one; this is the judgement about language, and it is the part
 * that decides whether the agent quotes something useful or something embarrassing.
 */
describe("what they rang about last time", () => {
  /**
   * Derived from the previous call's transcripts rather than stored on it. Nothing ever
   * wrote a subject anywhere, and a column would need something to fill it — a model
   * deciding what a call was about, or a heuristic pretending to. Their own first
   * substantive sentence needs neither.
   */
  it("skips the hellos and the name and finds the reason", () => {
    expect(
      subjectOf([
        "Hi, good afternoon.",
        "My name is Sikiru.",
        "I want to book a viewing in Lekki Phase One",
      ]),
    ).toBe("I want to book a viewing in Lekki Phase One");
  });

  it("skips a fragment too short to mean anything", () => {
    /* "the delivery" is something the agent would have to guess around, and guessing at
       what somebody rang about last week is worse than not raising it. */
    expect(subjectOf(["Yes.", "the delivery", "I am calling about my rent renewal"])).toBe(
      "I am calling about my rent renewal",
    );
  });

  it("gives up rather than quoting a greeting back at them", () => {
    expect(subjectOf(["Hello.", "Good morning.", "How are you doing"])).toBeNull();
  });

  it("finds the reason inside one breath of hellos, which is how it actually arrives", () => {
    /* The real shape. A caller says all of it in one turn and it lands as one transcript,
       so skipping whole lines would drop the reason along with the greeting. */
    expect(
      subjectOf([
        "Hi. Good evening. My name is Sikiru. How are you doing? I want to rent a two-bedroom in Ajah.",
      ]),
    ).toBe("I want to rent a two-bedroom in Ajah.");
  });

  it("is null when the previous call left no transcripts", () => {
    // They age out under `transcript_retention_days`, and the window outlives them.
    expect(subjectOf([])).toBeNull();
  });

  it("shortens anything too long to say back in one breath", () => {
    const long = `I am calling because ${"the situation is complicated ".repeat(10)}`;
    const subject = subjectOf([long]);
    expect(subject?.length).toBeLessThanOrEqual(121);
    expect(subject?.endsWith("…")).toBe(true);
  });
});
