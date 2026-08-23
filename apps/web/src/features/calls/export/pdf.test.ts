import { describe, expect, it } from "vitest";

import { toPdf } from "./pdf";
import type { Sheet } from "./sheet";

/**
 * What makes a PDF valid, and what this one deliberately gives up.
 *
 * The cross-reference table is a list of absolute byte offsets. A reader that finds one
 * wrong rejects the whole document, and nothing about the file looks wrong until it is
 * opened — so the offsets are checked here by following them, exactly as a reader would.
 *
 * The rest is about a promise this format cannot keep. A base-14 font is one byte per
 * character, so the output is reduced to ASCII rather than left to arrive as mojibake, and
 * these pin the reduction so it stays deliberate.
 */

const GENERATED = new Date("2026-08-23T22:00:00.000Z");

const sheetOf = (rows: readonly (readonly string[])[], columns = ["Name", "Phone"]): Sheet => ({
  title: "Collected data",
  columns,
  rows,
});

const asText = (bytes: Uint8Array): string => new TextDecoder("latin1").decode(bytes);

describe("the PDF", () => {
  it("announces itself and ends properly", () => {
    const text = asText(toPdf(sheetOf([["Sikiru", "0813"]]), GENERATED));
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("has a cross-reference entry pointing at every object", () => {
    /* Followed rather than counted. An offset that is merely present but wrong produces a
       file every checker calls well-formed and every reader refuses to open. */
    const text = asText(toPdf(sheetOf([["Sikiru", "0813"]]), GENERATED));

    const startxref = Number(/startxref\s+(\d+)/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");

    const table = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(text);
    const count = Number(table?.[1]);
    const entries = (table?.[2] ?? "").trimEnd().split("\n");
    expect(entries).toHaveLength(count);

    // Entry 0 is the free-list head; the rest must each land on their own object header.
    entries.slice(1).forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
    });
  });

  it("declares a stream length matching the bytes that follow", () => {
    const text = asText(toPdf(sheetOf([["Sikiru", "0813"]]), GENERATED));
    const stream = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(text);
    expect(stream).not.toBeNull();
    expect(new TextEncoder().encode(stream?.[2] ?? "").length).toBe(Number(stream?.[1]));
  });

  it("contains no byte a base-14 font could not carry", () => {
    /* The mojibake guard. A PDF literal string under WinAnsiEncoding is one byte per
       character, so a multi-byte UTF-8 sequence written into one reads back as two wrong
       characters — "José" as "JosÃ©". Every byte staying under 128 rules that out. */
    const bytes = toPdf(sheetOf([["José Ṣadé", "Adaeze Nwosu-Ọkọ"]]), GENERATED);
    expect([...bytes].filter((byte) => byte > 127)).toEqual([]);
  });

  it("strips the accent rather than the letter", () => {
    const text = asText(toPdf(sheetOf([["José Ṣadé", "Adaeze Nwosu-Ọkọ"]]), GENERATED));
    expect(text).toContain("Jose Sade");
    expect(text).toContain("Adaeze Nwosu-Oko");
  });

  it("turns typographic punctuation into its ASCII twin", () => {
    // An em dash becoming "?" mid-address reads as corruption; becoming "-" reads as an
    // address.
    const text = asText(toPdf(sheetOf([["12 Bode Thomas — flat 3", "‘quoted’"]]), GENERATED));
    expect(text).toContain("12 Bode Thomas - flat 3");
    expect(text).toContain("'quoted'");
    expect(text).not.toContain("?");
  });

  it("escapes the characters that would end a string early", () => {
    const text = asText(toPdf(sheetOf([["Ada (Sons) \\ Co", "0805"]]), GENERATED));
    expect(text).toContain("Ada \\(Sons\\) \\\\ Co");
  });

  it("repeats the column headings on every page", () => {
    /* A table whose headings are on page one only is a wall of unlabelled columns from
       page two onward. */
    const many = Array.from({ length: 200 }, (_, i) => [`Name ${i}`, `080${i}`]);
    const text = asText(toPdf(sheetOf(many), GENERATED));
    const pages = text.match(/\/Type \/Page[^s]/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
    expect((text.match(/\(Phone\) Tj/g) ?? []).length).toBe(pages.length);
  });

  it("numbers the pages so a printed stack can be put back in order", () => {
    const many = Array.from({ length: 200 }, (_, i) => [`Name ${i}`, `080${i}`]);
    const text = asText(toPdf(sheetOf(many), GENERATED));
    expect(text).toContain("page 1 of ");
    expect(text).toContain("page 2 of ");
  });

  it("truncates a value too wide for the page instead of overlapping the next column", () => {
    const wide = Array.from({ length: 12 }, (_, i) => `column ${i}`);
    const long = wide.map(() => "x".repeat(200));
    const text = asText(toPdf(sheetOf([long], wide), GENERATED));
    expect(text).toContain("...");
    expect(text).not.toContain("x".repeat(200));
  });

  it("still produces a page when there is nothing to show", () => {
    // An empty export must be an empty report, not a zero-byte file that looks like a fault.
    const text = asText(toPdf(sheetOf([]), GENERATED));
    expect(text).toContain("/Type /Page");
    expect(text).toContain("(Collected data) Tj");
  });
});
