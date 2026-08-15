import { describe, expect, it } from "vitest";

import { parseUnits, spokenForm } from "./knowledge.schema";

/**
 * The splitters, which decide what a caller is read.
 *
 * A unit is retrieved on its own and spoken on its own, so a bad split is not a tidiness
 * problem — it is somebody on a phone line being read half a sentence, or a table row with
 * no idea which branch it describes. These are the cases that produce that.
 */
describe("question and answer pairs", () => {
  it("takes the first line as the question and the rest as the answer", () => {
    const [unit] = parseUnits("faq", "How do I renew?\nCall us, or use the portal.");
    expect(unit).toEqual({ question: "How do I renew?", body: "Call us, or use the portal." });
  });

  it("keeps a multi-line answer as one piece", () => {
    // Retrieval returns whole units. A wrapped answer split into three would have the agent
    // read a third of it and stop.
    const [unit] = parseUnits("faq", "What do I need?\nYour policy number.\nAnd some ID.");
    expect(unit?.body).toBe("Your policy number. And some ID.");
  });

  it("keeps a lone line rather than dropping it", () => {
    /* It is still something the organisation wrote down. Silently discarding it would mean
       the agent says it does not know about a fact that was pasted in and appeared to save. */
    expect(parseUnits("faq", "Renewals open 30 days before expiry.")).toEqual([
      { question: null, body: "Renewals open 30 days before expiry." },
    ]);
  });
});

describe("a pasted table", () => {
  const rows = "Branch\tOpens\tCloses\nIkeja\t08:00\t17:00\nLekki\t09:00\t16:00";

  it("makes one piece per row, carrying the column names into it", () => {
    /* Retrieval is full-text and a caller asks "when does Ikeja close", not for a cell
       reference. Without the column names in the body there is nothing for "close" to match. */
    const units = parseUnits("table", rows);
    expect(units).toHaveLength(2);
    expect(units[0]?.body).toBe("Branch: Ikeja. Opens: 08:00. Closes: 17:00");
    expect(units[0]?.question).toBe("Ikeja");
  });

  it("reads a comma-separated paste too", () => {
    expect(parseUnits("table", "Branch,Opens\nIkeja,08:00")[0]?.body).toBe("Branch: Ikeja. Opens: 08:00");
  });

  it("drops an empty cell rather than speaking a blank", () => {
    // "Closes: " read aloud is worse than not mentioning closing time at all.
    expect(parseUnits("table", "Branch\tCloses\nIkeja\t")[0]?.body).toBe("Branch: Ikeja");
  });

  it("returns nothing for a header with no rows", () => {
    expect(parseUnits("table", "Branch\tOpens")).toEqual([]);
  });
});

describe("a pasted document", () => {
  it("keeps a heading with the passage it introduces", () => {
    /* Alone, "Cancellations" answers nothing, and the passage without it loses the word a
       caller is most likely to say. Together they are the shape retrieval ranks. */
    const [unit] = parseUnits("document", "Cancellations\n\nA policy may be cancelled within 14 days.");
    expect(unit).toEqual({
      question: "Cancellations",
      body: "A policy may be cancelled within 14 days.",
    });
  });

  it("does not mistake a sentence on its own for a heading", () => {
    const [unit] = parseUnits("document", "A policy may be cancelled within 14 days of purchase.");
    expect(unit?.question).toBeNull();
  });

  it("keeps a trailing heading rather than losing it", () => {
    expect(parseUnits("document", "Body text here.\n\nAppendix")).toHaveLength(2);
  });
});

describe("what the preview shows", () => {
  it("reads as the caller would hear it", () => {
    expect(spokenForm({ question: "When do you open?", body: "Eight." })).toBe(
      "When do you open? — Eight.",
    );
    expect(spokenForm({ question: null, body: "Eight." })).toBe("Eight.");
  });
});
