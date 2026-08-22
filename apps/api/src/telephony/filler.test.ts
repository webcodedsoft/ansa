import { describe, expect, it } from "vitest";

import { ACKNOWLEDGEMENTS, PROGRESS, createFillerPicker } from "./filler";

describe("createFillerPicker", () => {
  // Round-robin was the obvious choice and the wrong one: a caller hears the same cycle
  // in the same order and it stops sounding like a person.
  it("never returns the same filler twice in a row", () => {
    const picker = createFillerPicker();
    let previous: string | null = null;

    for (let i = 0; i < 200; i += 1) {
      const next = picker.next(ACKNOWLEDGEMENTS);
      expect(next).not.toBe(previous);
      previous = next;
    }
  });

  it("uses the whole pool rather than alternating between two", () => {
    const picker = createFillerPicker();
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) seen.add(picker.next(ACKNOWLEDGEMENTS) ?? "");

    expect(seen.size).toBe(ACKNOWLEDGEMENTS.length);
  });

  it("copes with a pool of one without looping forever", () => {
    const picker = createFillerPicker();
    expect(picker.next(["Okay."])).toBe("Okay.");
    expect(picker.next(["Okay."])).toBe("Okay.");
  });

  it("returns null for an empty pool", () => {
    expect(createFillerPicker().next([])).toBeNull();
  });

  it("does not carry the no-repeat rule across different pools", () => {
    const picker = createFillerPicker();
    picker.next(ACKNOWLEDGEMENTS);
    expect(PROGRESS).toContain(picker.next(PROGRESS));
  });
});

describe("the filler registers", () => {
  it("keeps acknowledgement and progress separate", () => {
    // A second "mm-hm" three seconds in sounds like the line is stuck; the caller needs
    // to hear that something is happening.
    for (const phrase of ACKNOWLEDGEMENTS) expect(PROGRESS).not.toContain(phrase);
  });

  it("keeps every filler short enough not to collide with the reply", () => {
    for (const phrase of [...ACKNOWLEDGEMENTS, ...PROGRESS]) {
      expect(phrase.length).toBeLessThan(24);
    }
  });
});

describe("not saying the same thing twice on one call", () => {
  /**
   * Avoiding only the previous phrase was not enough. Eight acknowledgements across a
   * twelve-turn call meant the caller heard "Mm-hm" three or four times, and one repeat
   * inside a single conversation is more damaging than a slightly less apt phrase.
   */
  const POOL = ["a", "b", "c", "d"];

  it("uses every phrase before repeating any", () => {
    const picker = createFillerPicker(() => 0);
    const said = POOL.map(() => picker.next(POOL));
    expect(new Set(said).size).toBe(POOL.length);
  });

  it("starts the pool again rather than falling silent", () => {
    /* Silence where the caller expects a sound is the failure R6.2 exists to prevent, and
       it is worse than a repeat on the ninth wait of one conversation. */
    const picker = createFillerPicker(() => 0);
    for (const _ of POOL) picker.next(POOL);
    expect(picker.next(POOL)).not.toBeNull();
  });

  it("still never says the same thing twice running, across the reset", () => {
    const picker = createFillerPicker(() => 0);
    const said = Array.from({ length: 12 }, () => picker.next(POOL));
    for (let i = 1; i < said.length; i += 1) expect(said[i]).not.toBe(said[i - 1]);
  });

  it("keeps each tier's memory to itself", () => {
    /* Tiers are exhausted at different rates — the first fires on most turns and the third
       only on slow ones. Exhausting one must not forget another that is still working.
       The order matters and the first version of this test got it wrong: `second` has to
       be partly used *before* `first` runs out, or a global clear behaves identically to
       a per-tier one and the assertion proves nothing. */
    const first = ["a", "b"];
    const second = ["x", "y", "z"];
    const picker = createFillerPicker(() => 0);

    const firstFromSecond = picker.next(second);
    picker.next(first);
    picker.next(first);
    // `first` is now exhausted and resets. `second` must still remember what it has said.
    picker.next(first);

    const rest = [picker.next(second), picker.next(second)];
    expect(rest).not.toContain(firstFromSecond);
  });

  it("is one per call, so a new call starts fresh", () => {
    // The state is the whole point, and it must not outlive the conversation it belongs to.
    const one = createFillerPicker(() => 0);
    for (const _ of POOL) one.next(POOL);
    const next = createFillerPicker(() => 0);
    expect(new Set(POOL.map(() => next.next(POOL))).size).toBe(POOL.length);
  });
});
