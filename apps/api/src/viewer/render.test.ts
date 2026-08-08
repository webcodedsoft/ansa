import { describe, expect, it } from "vitest";

import { renderCall, renderCallList } from "./render";

const LINK = { token: "t", tenant: "abc-123" };

const summary = {
  id: "c1",
  carrierCallId: "CA1",
  direction: "inbound",
  dialled: "+18148592625",
  caller: "+2348138178550",
  answeredAt: new Date("2026-08-08T12:00:00Z"),
  endedAt: null,
  endReason: null,
  durationSeconds: null,
  turnCount: 2,
};

describe("the viewer escapes everything from a call", () => {
  it("escapes caller speech, which is arbitrary text we did not write", () => {
    // A transcriber will happily return this if a caller says it, and an internal tool is
    // still a tool someone is logged into.
    const html = renderCall({
      summary,
      events: [],
      transcripts: [
        { text: '<script>alert("x")</script>', correctedText: null, confidence: 0.9, offsetMs: 10, provider: "openai" },
      ],
    }, LINK);

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes event detail, which carries vendor error strings", () => {
    const html = renderCall({
      summary,
      events: [{ kind: "vendor error", offsetMs: 5, detail: { message: '</td><img src=x onerror=1>' }, at: new Date() }],
      transcripts: [],
    }, LINK);
    expect(html).not.toContain("<img src=x");
  });

  it("escapes the numbers in the header too", () => {
    const html = renderCall({
      summary: { ...summary, dialled: '"><b>x</b>' },
      events: [],
      transcripts: [],
    }, LINK);
    expect(html).not.toContain("<b>x</b>");
  });

  it("escapes a call id in a link rather than trusting it", () => {
    const html = renderCallList([{ ...summary, id: '"><script>' }], LINK);
    expect(html).not.toContain("<script>");
  });
});

describe("the viewer answers the question a reviewer is asking", () => {
  it("puts transcripts and events on one timeline, in order", () => {
    // "What did it hear, and what did it do about it" is unanswerable across two tables.
    const html = renderCall({
      summary,
      events: [{ kind: "barge-in", offsetMs: 2000, detail: {}, at: new Date() }],
      transcripts: [
        { text: "second", correctedText: null, confidence: null, offsetMs: 3000, provider: "openai" },
        { text: "first", correctedText: null, confidence: null, offsetMs: 1000, provider: "openai" },
      ],
    }, LINK);

    expect(html.indexOf("first")).toBeLessThan(html.indexOf("barge-in"));
    expect(html.indexOf("barge-in")).toBeLessThan(html.indexOf("second"));
  });

  it("shows a correction alongside what was actually heard", () => {
    // Both, always: the correction is the truth and the mishearing is the evidence, and
    // the review loop needs to see them together to be worth anything.
    const html = renderCall({
      summary,
      events: [],
      transcripts: [
        { text: "Security", correctedText: "Sikiru", confidence: 0.4, offsetMs: 10, provider: "openai" },
      ],
    }, LINK);
    expect(html).toContain("Sikiru");
    expect(html).toContain("Security");
  });

  it("says so plainly when there is nothing to show", () => {
    expect(renderCallList([], LINK)).toContain("No calls recorded yet");
  });
});

describe("links have to survive being clicked", () => {
  const link = { token: "tok en", tenant: "abc-123" };

  it("keeps the /viewer prefix, which a relative href silently dropped", () => {
    // "./id" against "/viewer" resolves to "/id" — the browser went to the root and got
    // a 404 from Nest.
    const html = renderCallList([summary], link);
    expect(html).toContain('href="/viewer/c1?');
  });

  it("carries the credentials, since there is no session to fall back on", () => {
    const html = renderCallList([summary], link);
    expect(html).toContain("token=tok%20en");
    expect(html).toContain("tenant=abc-123");
  });

  it("points back at the list from a call, credentials intact", () => {
    const html = renderCall({ summary, events: [], transcripts: [] }, link);
    expect(html).toContain('href="/viewer?token=tok%20en&amp;tenant=abc-123"');
  });

  it("encodes an id rather than pasting it into a URL", () => {
    const html = renderCallList([{ ...summary, id: "a/b?c" }], link);
    expect(html).not.toContain("/viewer/a/b?c?");
  });
});
