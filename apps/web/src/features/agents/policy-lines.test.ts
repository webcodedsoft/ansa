import { describe, expect, it } from "vitest";

import { adviseLines, applySplit, countEntries, splitPasted, stripBullet } from "./policy-lines";

/**
 * The hint said "One per line" and nothing made it true.
 *
 * These are written against the two things that actually happen — somebody pastes a list out of
 * a handbook, and somebody types several rules on one line — rather than against tidy input.
 * The second is a guess, so its tests check that the guess stays *shown* and never applied on
 * its own, and that the shape it is most likely to get wrong is left alone.
 */

const MAX_LINE = 300;

describe("pasting a list somebody wrote somewhere else", () => {
  it("takes the numbering off", () => {
    expect(splitPasted("1. Issue a refund\n2. Explain the timeline")).toEqual([
      "Issue a refund",
      "Explain the timeline",
    ]);
  });

  it("takes bullets off, in the shapes a document editor produces", () => {
    expect(splitPasted("• Issue a refund\n- Explain it\n* Escalate\n– Log it")).toEqual([
      "Issue a refund",
      "Explain it",
      "Escalate",
      "Log it",
    ]);
  });

  it("handles the lettered form and the parenthesised one", () => {
    expect(splitPasted("a) Issue a refund\n(b) Explain it\n(1) Escalate")).toEqual([
      "Issue a refund",
      "Explain it",
      "Escalate",
    ]);
  });

  it("drops the blank lines a double-spaced list arrives with", () => {
    expect(splitPasted("Issue a refund\n\n\nExplain the timeline")).toHaveLength(2);
  });

  it("copes with the line endings a Windows document brings", () => {
    expect(splitPasted("Issue a refund\r\nExplain it\rEscalate")).toHaveLength(3);
  });

  it("leaves a dash inside a sentence alone", () => {
    /* Only a leading marker is formatting. This is the case `policy-text.test.ts` pins for the
       round trip, and stripping it here would break it from the other end. */
    expect(stripBullet("Refund the part that did not arrive - not the whole order")).toBe(
      "Refund the part that did not arrive - not the whole order",
    );
  });

  it("keeps a word that only looks like a letter marker", () => {
    expect(stripBullet("a refund is issued within 14 days")).toBe(
      "a refund is issued within 14 days",
    );
  });
});

describe("counting what is actually in the box", () => {
  it("ignores the blank lines somebody leaves while typing", () => {
    expect(countEntries("Issue a refund\n\nExplain it\n")).toBe(2);
  });

  it("is zero for an empty box", () => {
    expect(countEntries("")).toBe(0);
  });
});

describe("a line that looks like several", () => {
  it("suggests a split on semicolons", () => {
    const [advice] = adviseLines("Issue a refund; explain the timeline", MAX_LINE);
    expect(advice?.reason).toBe("semicolons");
    expect(advice?.parts).toEqual(["Issue a refund", "explain the timeline"]);
  });

  it("leaves a qualifying comma alone", () => {
    /* The shape the guess is most likely to get wrong. One comma, short line — this is one
       entry, and suggesting otherwise is the noise that makes people stop reading advice. */
    expect(adviseLines("Refund the order, minus shipping", MAX_LINE)).toEqual([]);
  });

  it("suggests a split on a long line carrying several commas", () => {
    const line =
      "Issue a refund within 14 days, explain the refund timeline to the caller, " +
      "and log the reference against the account";
    const [advice] = adviseLines(line, MAX_LINE);
    expect(advice?.reason).toBe("commas");
    expect(advice?.parts).toHaveLength(3);
  });

  it("names an over-long line but offers nowhere to cut it", () => {
    const [advice] = adviseLines("x".repeat(MAX_LINE + 1), MAX_LINE);
    expect(advice?.reason).toBe("too-long");
    expect(advice?.parts).toEqual([]);
  });

  it("says nothing about a line that is one rule", () => {
    expect(adviseLines("Issue a refund within 14 days", MAX_LINE)).toEqual([]);
  });
});

describe("taking the suggestion", () => {
  it("replaces only the line it was about", () => {
    const text = "Keep this\nIssue a refund; explain it\nAnd this";
    const [advice] = adviseLines(text, MAX_LINE);
    expect(advice).toBeDefined();
    expect(applySplit(text, advice as NonNullable<typeof advice>)).toBe(
      "Keep this\nIssue a refund\nexplain it\nAnd this",
    );
  });

  it("changes nothing when there is nowhere to cut", () => {
    const text = "x".repeat(MAX_LINE + 1);
    const [advice] = adviseLines(text, MAX_LINE);
    expect(applySplit(text, advice as NonNullable<typeof advice>)).toBe(text);
  });
});
