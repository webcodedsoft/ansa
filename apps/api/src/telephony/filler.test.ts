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
