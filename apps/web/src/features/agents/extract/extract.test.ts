import { deflateRawSync, deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { extractText, nameFromFile } from "./index";
import { extractPdf } from "./pdf";
import { readZipEntry } from "./zip";

/**
 * The formats these read are ones we do not control, so every test here builds a real file — a
 * real ZIP with a real central directory, a real PDF with real content streams — rather than
 * asserting against a hand-written string the parser happens to accept.
 *
 * The refusals are the tests that matter most. A parser that returns rubbish confidently is
 * worse than one that fails, because the rubbish reaches a caller.
 */

/** A ZIP holding one deflated entry, built the way a .docx is. */
const zipWith = (name: string, contents: string): Buffer => {
  const nameBytes = Buffer.from(name, "utf8");
  const raw = Buffer.from(contents, "utf8");
  const deflated = deflateRawSync(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const body = Buffer.concat([local, nameBytes, deflated]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);

  const directory = Buffer.concat([central, nameBytes]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);

  return Buffer.concat([body, directory, end]);
};

const docx = (xml: string): Buffer => zipWith("word/document.xml", xml);

const paragraph = (...runs: readonly string[]): string =>
  `<w:p>${runs.map((run) => `<w:r><w:t xml:space="preserve">${run}</w:t></w:r>`).join("")}</w:p>`;

const row = (...cells: readonly string[]): string =>
  `<w:tr>${cells.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join("")}</w:tr>`;

/** A PDF with one content stream painting the given lines. */
const pdfWith = (lines: readonly string[], compress = true): Buffer => {
  const escaped = lines.map((line) => line.replace(/([()\\])/g, "\\$1"));
  const content = `BT ${escaped.map((line) => `Td (${line}) Tj`).join(" ")} ET`;
  const stream = compress
    ? deflateSync(Buffer.from(content, "latin1"))
    : Buffer.from(content, "latin1");
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n4 0 obj\n<< /Length 1 >>\nstream\n", "latin1"),
    stream,
    Buffer.from("\nendstream\nendobj\ntrailer\n%%EOF", "latin1"),
  ]);
};

describe("readZipEntry", () => {
  it("inflates the entry it was asked for", () => {
    const entry = readZipEntry(zipWith("word/document.xml", "<x>hello</x>"), "word/document.xml");
    expect(entry?.toString("utf8")).toBe("<x>hello</x>");
  });

  it("is null for an entry the archive does not hold", () => {
    expect(readZipEntry(zipWith("a.xml", "<a/>"), "word/document.xml")).toBeNull();
  });

  it("is null rather than throwing on bytes that are not a ZIP", () => {
    expect(
      readZipEntry(Buffer.from("not a zip at all, not even close"), "word/document.xml"),
    ).toBeNull();
  });
});

describe("extractText — Word", () => {
  it("keeps paragraphs separated so a document splits into passages", () => {
    const file = docx(
      `<w:document><w:body>${paragraph("Cancellations")}${paragraph("A policy may be cancelled within 14 days.")}</w:body></w:document>`,
    );
    const { text, refusal } = extractText("terms.docx", file);

    expect(refusal).toBeNull();
    // The blank line is load-bearing: `parseUnits` splits a document on it, and without it the
    // whole file arrives as one passage.
    expect(text).toBe("Cancellations\n\nA policy may be cancelled within 14 days.");
  });

  it("turns a table into tab-separated rows on single lines", () => {
    const file = docx(
      `<w:document><w:body><w:tbl>${row("Branch", "Opens")}${row("Ikeja", "08:00")}</w:tbl></w:body></w:document>`,
    );
    const { text, suggests } = extractText("branches.docx", file);

    expect(text).toBe("Branch\tOpens\nIkeja\t08:00");
    // One row per line with no blank line between them is what makes this a table rather than
    // two passages, and the shape detector has to agree.
    expect(suggests).toBe("table");
  });

  it("does not split a row when a cell holds two paragraphs", () => {
    const file = docx(
      `<w:document><w:body><w:tbl><w:tr><w:tc>${paragraph("Ikeja")}</w:tc><w:tc>${paragraph("14 Allen Avenue")}${paragraph("Lagos")}</w:tc></w:tr></w:tbl></w:body></w:document>`,
    );
    expect(extractText("branches.docx", file).text).toBe("Ikeja\t14 Allen Avenue Lagos");
  });

  it("decodes entities rather than storing them literally", () => {
    const file = docx(
      `<w:document><w:body>${paragraph("Terms &amp; conditions &#8212; 2026")}</w:body></w:document>`,
    );
    expect(extractText("t.docx", file).text).toBe("Terms & conditions — 2026");
  });

  it("refuses a ZIP that is not a Word document", () => {
    const { text, refusal } = extractText("something.docx", zipWith("other.xml", "<a/>"));
    expect(text).toBe("");
    expect(refusal).toContain(".docx");
  });
});

describe("extractText — PDF", () => {
  it("reads a compressed content stream", () => {
    const { text, refusal } = extractPdf(
      pdfWith(["How do I renew my motor policy?", "Call us or use the portal."]),
    );
    expect(refusal).toBeNull();
    expect(text).toContain("How do I renew my motor policy?");
    expect(text).toContain("Call us or use the portal.");
  });

  it("reads an uncompressed one too", () => {
    const { text } = extractPdf(pdfWith(["Renewal opens 30 days before expiry, every year."], false));
    expect(text).toContain("Renewal opens 30 days before expiry");
  });

  it("keeps a bracketed aside instead of truncating at the first close paren", () => {
    const { text } = extractPdf(pdfWith(["Agency fee (ten per cent) is payable on signing."]));
    expect(text).toContain("Agency fee (ten per cent) is payable");
  });

  it("refuses a scan rather than returning nothing and calling it success", () => {
    const scan = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\ntrailer\n%%EOF", "latin1");
    const { text, refusal } = extractPdf(scan);
    expect(text).toBe("");
    expect(refusal).toContain("scan");
  });

  it("refuses text that came back as unmappable glyph codes", () => {
    // What a subset font with a custom encoding actually produces: the right shape, the wrong
    // characters. Returning this would have an agent read rubbish down the phone.
    const glyphs = Array.from({ length: 60 }, (_, at) => String.fromCharCode(1 + (at % 25))).join("");
    const { text, refusal } = extractPdf(pdfWith([glyphs]));
    expect(text).toBe("");
    expect(refusal).toContain("nonsense");
  });
});

describe("extractText — plain files and guards", () => {
  it("detects question pairs in a pasted text file", () => {
    const file = Buffer.from(
      "How do I renew?\nCall us.\n\nWhat do I need?\nYour policy number.",
      "utf8",
    );
    expect(extractText("faq.txt", file).suggests).toBe("faq");
  });

  it("detects a table in a CSV", () => {
    const file = Buffer.from(
      "Branch,Address,Opens\nIkeja,14 Allen,08:00\nLekki,3 Admiralty,09:00",
      "utf8",
    );
    expect(extractText("branches.csv", file).suggests).toBe("table");
  });

  it("strips a byte-order mark so the first word is searchable", () => {
    const file = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("Branch opening hours", "utf8"),
    ]);
    expect(extractText("hours.txt", file).text.startsWith("Branch")).toBe(true);
  });

  it("refuses a file saved in the wrong encoding instead of storing diamonds", () => {
    // Windows-1252 for "Café " repeated: the 0xe9 is invalid UTF-8 and decodes to U+FFFD.
    const file = Buffer.from(Array.from({ length: 40 }, () => [0x43, 0x61, 0x66, 0xe9, 0x20]).flat());
    const { text, refusal } = extractText("prices.txt", file);
    expect(text).toBe("");
    expect(refusal).toContain("UTF-8");
  });

  it("refuses an extension it does not read, and names it", () => {
    const { refusal } = extractText("policy.doc", Buffer.from("anything at all"));
    expect(refusal).toContain(".doc");
  });

  it("refuses a file over the size cap", () => {
    const { refusal } = extractText("big.txt", Buffer.alloc(9 * 1024 * 1024, 0x61));
    expect(refusal).toContain("MB");
  });

  it("refuses an empty file", () => {
    expect(extractText("empty.txt", Buffer.alloc(0)).refusal).toBe("That file is empty.");
  });
});

describe("nameFromFile", () => {
  it("drops the extension and reads separators as spaces", () => {
    expect(nameFromFile("Oakhaven-lettings_2026.pdf")).toBe("Oakhaven lettings 2026");
  });

  it("leaves a name that is already prose alone", () => {
    expect(nameFromFile("Motor policy FAQ.docx")).toBe("Motor policy FAQ");
  });
});
