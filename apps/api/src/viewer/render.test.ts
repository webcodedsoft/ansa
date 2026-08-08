import { describe, expect, it } from "vitest";

import { scoreCalls } from "./metrics";
import {
  renderCall,
  renderCallList,
  renderCorpus,
  renderCorpusJsonl,
  renderMetrics,
} from "./render";

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
        { id: "t1", text: '<script>alert("x")</script>', correctedText: null, confidence: 0.9, offsetMs: 10, provider: "openai" },
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
        { id: "t1", text: "second", correctedText: null, confidence: null, offsetMs: 3000, provider: "openai" },
        { id: "t2", text: "first", correctedText: null, confidence: null, offsetMs: 1000, provider: "openai" },
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
        { id: "t1", text: "Security", correctedText: "Sikiru", confidence: 0.4, offsetMs: 10, provider: "openai" },
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

describe("recording a correction (R9.2.3)", () => {
  const detail = {
    summary,
    events: [],
    transcripts: [
      { id: "t-42", text: "Security", correctedText: null, confidence: 0.4, offsetMs: 10, provider: "openai" },
    ],
  };

  it("offers a box against every transcript, pre-filled with what was heard", () => {
    // Most turns are right and a reviewer's job is mostly to say so. Retyping a correct
    // sentence to record that it was correct is how a review queue stops being used.
    const html = renderCall(detail, LINK);
    expect(html).toContain('name=transcriptId value="t-42"');
    expect(html).toContain('name=correctedText value="Security"');
  });

  it("posts, because it writes", () => {
    const html = renderCall(detail, LINK);
    expect(html).toContain('method=post action="/viewer/c1/corrections"');
  });

  it("carries the credentials in the body rather than the address bar", () => {
    // There is no session, and a token in a form action ends up in browser history and
    // in the Referer of anything the page links to.
    const html = renderCall(detail, LINK);
    expect(html).toContain('type=hidden name=token value="t"');
    expect(html).toContain('type=hidden name=tenant value="abc-123"');
  });

  it("escapes a transcript before putting it inside an attribute", () => {
    const html = renderCall(
      {
        ...detail,
        transcripts: [
          { id: 't"><script>', text: '"><script>alert(1)</script>', correctedText: null, confidence: null, offsetMs: 1, provider: "openai" },
        ],
      },
      LINK,
    );
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain('value=""><');
  });
});

describe("the metrics page", () => {
  const metrics = scoreCalls([
    {
      callId: "c1",
      endReason: "carrier sent stop",
      durationSeconds: 30,
      callerTurns: 4,
      agentTurns: 4,
      events: [
        { kind: "latency", detail: { stage: "turn_to_audio", ms: 900 } },
        { kind: "barge-in", detail: {} },
      ],
      reviewed: [{ heard: "Security", corrected: "Sikiru" }],
    },
  ]);

  it("puts the definition next to the number", () => {
    // A metric whose meaning lives in someone's head is a number two people read
    // differently.
    const html = renderMetrics(metrics, LINK, { calls: 1 });
    expect(html).toContain("Response latency p50");
    expect(html).toContain("900ms");
    expect(html).toContain("caller stopped");
  });

  it("shows an em dash rather than a zero for a metric with no samples", () => {
    const empty = renderMetrics(scoreCalls([]), LINK, { calls: 0 });
    expect(empty).toContain("—");
    expect(empty).not.toContain("0.0%");
  });
});

describe("the eval corpus", () => {
  const entry = {
    transcriptId: "t1",
    callId: "c1",
    carrierCallId: "CA1",
    offsetMs: 1000,
    provider: "openai",
    confidence: 0.4,
    heard: "My name is Security",
    corrected: "My name is Sikiru",
    correctedAt: new Date("2026-08-08T12:00:00Z"),
  };

  it("shows the mishearing beside the truth, with its error rate", () => {
    const html = renderCorpus([entry], LINK);
    expect(html).toContain("Security");
    expect(html).toContain("Sikiru");
    expect(html).toContain("0.25");
  });

  it("exports one JSON object per line, so the corpus can be appended to", () => {
    const jsonl = renderCorpusJsonl([entry, { ...entry, transcriptId: "t2" }]);
    const lines = jsonl.split("\n");
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed["heard"]).toBe("My name is Security");
    expect(parsed["corrected"]).toBe("My name is Sikiru");
    expect(parsed["wer"]).toBeCloseTo(0.25);
  });

  it("says so plainly when nobody has reviewed anything", () => {
    expect(renderCorpus([], LINK)).toContain("Nothing reviewed yet");
  });
});
