import type { CallDetail, CallSummary, CorpusEntry } from "@ansa/db";

import { wordErrorRate, type QualityMetrics } from "./metrics";

/**
 * The internal call viewer's HTML (R8.1).
 *
 * Server-rendered strings, no framework, no client JavaScript. CLAUDE.md is explicit that
 * building a nice UI here is a temptation to resist — this is for debugging and ugly is
 * fine. What it must be is correct and safe.
 */

/**
 * Everything from a call is escaped, without exception.
 *
 * The content is caller speech, transcriber output and vendor error strings — none of it
 * ours, all of it arbitrary. An internal tool is still a tool someone is logged into, and
 * "it's only for us" is how stored XSS lives for years.
 */
const esc = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Credentials that have to survive every link.
 *
 * There is no session here — the token and tenant live in the query string, so a link
 * that drops them is a link to a 403. The first version used a relative href and lost
 * both, and lost the /viewer prefix as well: "./id" against "/viewer" resolves to "/id".
 */
export interface ViewerLink {
  readonly token: string;
  readonly tenant: string;
}

const href = (link: ViewerLink, path = ""): string =>
  `/viewer${path === "" ? "" : `/${encodeURIComponent(path)}`}` +
  `?token=${encodeURIComponent(link.token)}&tenant=${encodeURIComponent(link.tenant)}`;

/**
 * The credentials again, as form fields.
 *
 * A POST cannot carry them in a relative action without putting the token in the address
 * bar of every reviewer's browser history, and there is no session to hold them in.
 */
const credentials = (link: ViewerLink): string =>
  `<input type=hidden name=token value="${esc(link.token)}">` +
  `<input type=hidden name=tenant value="${esc(link.tenant)}">`;

const percent = (value: number | null): string =>
  value === null ? "—" : `${(value * 100).toFixed(1)}%`;

const ms = (value: number | null): string => (value === null ? "—" : `${Math.round(value)}ms`);

const secs = (ms: number | null): string => (ms === null ? "—" : `${(ms / 1000).toFixed(2)}s`);

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
  `<style>
    body{font:14px/1.5 ui-monospace,Menlo,monospace;margin:2rem;max-width:60rem;color:#111}
    table{border-collapse:collapse;width:100%}
    td,th{border-bottom:1px solid #ddd;padding:.35rem .6rem;text-align:left;vertical-align:top}
    th{background:#f4f4f4}
    .caller{color:#0a5}
    .agent{color:#05a}
    .warn{color:#a50}
    a{color:#05a}
    .muted{color:#777}
    .good{color:#0a5}
    form{display:inline}
    input[type=text]{font:inherit;width:22rem;padding:.15rem .3rem}
    button{font:inherit;padding:.15rem .5rem}
    .num{text-align:right;font-variant-numeric:tabular-nums}
  </style></head><body>${body}</body></html>`;

export const renderCallList = (calls: readonly CallSummary[], link: ViewerLink): string =>
  page(
    "Calls",
    `<h1>Calls</h1>` +
      `<p><a href="${esc(href(link, "metrics"))}">metrics</a> · ` +
      `<a href="${esc(href(link, "corpus.jsonl"))}">corpus (jsonl)</a></p>` +
      (calls.length === 0
        ? "<p class=muted>No calls recorded yet.</p>"
        : `<table><tr><th>When<th>Dir<th>Dialled<th>Caller<th>Turns<th>Ended<th></tr>` +
          calls
            .map(
              (c) =>
                `<tr><td>${esc(c.answeredAt?.toISOString() ?? "—")}` +
                `<td>${esc(c.direction)}` +
                `<td>${esc(c.dialled)}` +
                `<td>${esc(c.caller ?? "—")}` +
                `<td>${esc(c.turnCount)}` +
                `<td>${esc(c.endReason ?? "in progress")}` +
                `<td><a href="${esc(href(link, c.id))}">open</a></tr>`,
            )
            .join("") +
          "</table>"),
  );

export const renderCall = (call: CallDetail, link: ViewerLink): string => {
  const s = call.summary;

  // Transcripts and events on one timeline, ordered by when they happened. A reviewer is
  // asking "what did it hear, and what did it do about it" — two separate tables make
  // that question unanswerable.
  /**
   * The correction box (R9.2.3).
   *
   * Pre-filled with what the transcriber heard, because most turns are right and a
   * reviewer's job is mostly to say so. Submitting it unchanged is a verdict too — it is
   * what makes "reviewed" a bigger set than "wrong", and without that distinction no
   * accuracy rate can be computed from this table at all.
   */
  const correctionForm = (transcriptId: string, value: string): string =>
    `<form method=post action="/viewer/${encodeURIComponent(s.id)}/corrections">` +
    credentials(link) +
    `<input type=hidden name=transcriptId value="${esc(transcriptId)}">` +
    `<input type=text name=correctedText value="${esc(value)}">` +
    `<button type=submit>correct</button></form>`;

  const rows = [
    ...call.transcripts.map((t) => ({
      offsetMs: t.offsetMs,
      kind: "caller said",
      body:
        `<span class=caller>${esc(t.correctedText ?? t.text)}</span>` +
        (t.correctedText === null ? "" : `<br><span class=muted>heard: ${esc(t.text)}</span>`) +
        `<br><span class=muted>${esc(t.provider)}` +
        (t.confidence === null ? "" : ` · confidence ${esc(t.confidence.toFixed(2))}`) +
        `</span><br>` +
        correctionForm(t.id, t.correctedText ?? t.text),
    })),
    ...call.events.map((e) => ({
      offsetMs: e.offsetMs ?? 0,
      kind: e.kind,
      body: `<span class=${e.kind.includes("hallucination") || e.kind.includes("escalat") ? "warn" : "agent"}>${esc(
        JSON.stringify(e.detail),
      )}</span>`,
    })),
  ].sort((a, b) => a.offsetMs - b.offsetMs);

  return page(
    `Call ${s.carrierCallId}`,
    `<p><a href="${esc(href(link))}">&larr; all calls</a></p>` +
      `<h1>${esc(s.direction)} · ${esc(s.dialled)}</h1>` +
      `<p class=muted>${esc(s.carrierCallId)} · caller ${esc(s.caller ?? "withheld")} · ` +
      `${esc(s.durationSeconds ?? "—")}s · ended: ${esc(s.endReason ?? "in progress")}</p>` +
      `<table><tr><th>At<th>What<th>Detail</tr>` +
      rows
        .map((r) => `<tr><td>${esc(secs(r.offsetMs))}<td>${esc(r.kind)}<td>${r.body}</tr>`)
        .join("") +
      `</table>`,
  );
};

/**
 * The scoreboard (R9.2.6).
 *
 * Every row carries its definition, because a metric whose meaning lives in someone's
 * head is a number two people will read differently. The targets are R10's, quoted rather
 * than recomputed — this page is for noticing a change, not for declaring a pass.
 */
export const renderMetrics = (
  metrics: QualityMetrics,
  link: ViewerLink,
  window: { readonly calls: number },
): string => {
  const row = (name: string, value: string, meaning: string): string =>
    `<tr><td>${esc(name)}<td class=num>${esc(value)}<td class=muted>${esc(meaning)}</tr>`;

  return page(
    "Metrics",
    `<p><a href="${esc(href(link))}">&larr; all calls</a></p>` +
      `<h1>Quality</h1>` +
      `<p class=muted>Over the last ${esc(window.calls)} calls · ` +
      `${esc(metrics.callerTurns)} caller turns · ${esc(metrics.agentTurns)} agent turns</p>` +
      `<table><tr><th>Metric<th>Value<th>What it means</tr>` +
      row(
        "STT exact match",
        percent(metrics.sttExactMatch),
        `reviewed turns the transcriber got word-for-word right (${metrics.reviewed} reviewed)`,
      ) +
      row("STT word accuracy", percent(metrics.sttWordAccuracy), "1 − WER against the reviewer's text") +
      row("Correction rate", percent(metrics.correctionRate), "reviewed turns a human had to change") +
      row("Confirmation rate", percent(metrics.confirmationRate), "caller turns that triggered a readback") +
      row(
        "Readback rejection",
        percent(metrics.readbackRejectionRate),
        "readbacks the caller said no to — first-try number accuracy is its complement",
      ) +
      row("Capture completion", percent(metrics.captureCompletionRate), "readbacks that ended in a confirmed value") +
      row("Barge-in rate", percent(metrics.bargeInRate), "agent turns the caller interrupted") +
      row(
        "Response latency p50",
        ms(metrics.responseLatencyMs.p50),
        `caller stopped → first reply audio, target 800ms (${metrics.responseLatencyMs.samples} turns)`,
      ) +
      row("Response latency p95", ms(metrics.responseLatencyMs.p95), "the tail is what a caller remembers") +
      row("Transfer rate", percent(metrics.transferRate), "calls that escalated to a human") +
      row("Abandonment", percent(metrics.abandonmentRate), "calls where the caller never took a turn") +
      row(
        "Hallucinations discarded",
        String(metrics.hallucinationsDiscarded),
        "transcripts invented from silence and thrown away — any at all is worth reading",
      ) +
      `</table>`,
  );
};

/**
 * The corpus, as a page a human can read before trusting the file.
 *
 * The machine-readable export is JSONL from the same query; this exists so a reviewer can
 * see what they have actually built without piping a file through jq.
 */
export const renderCorpus = (entries: readonly CorpusEntry[], link: ViewerLink): string =>
  page(
    "Corpus",
    `<p><a href="${esc(href(link))}">&larr; all calls</a></p>` +
      `<h1>Eval corpus</h1>` +
      `<p class=muted>${esc(entries.length)} reviewed turns. Every one of them is a ` +
      `regression test: the pairs that agree score the incumbent, the pairs that differ ` +
      `are the failures.</p>` +
      (entries.length === 0
        ? "<p class=muted>Nothing reviewed yet.</p>"
        : `<table><tr><th>Heard<th>Truth<th>WER<th>Provider<th>Call</tr>` +
          entries
            .map((e) => {
              const wer = wordErrorRate(e.heard, e.corrected);
              const same = wer === 0;
              return (
                `<tr><td class=${same ? "muted" : "warn"}>${esc(e.heard)}` +
                `<td class=${same ? "muted" : "good"}>${esc(e.corrected)}` +
                `<td class=num>${esc(wer === null ? "—" : wer.toFixed(2))}` +
                `<td>${esc(e.provider)}` +
                `<td><a href="${esc(href(link, e.callId))}">${esc(e.carrierCallId)}</a></tr>`
              );
            })
            .join("") +
          "</table>"),
  );

/**
 * The corpus as JSON Lines, which is what the eval harness reads.
 *
 * One object per line, no wrapping array: a corpus grows, and a format that has to be
 * parsed whole to be appended to is a format that gets rewritten later.
 */
export const renderCorpusJsonl = (entries: readonly CorpusEntry[]): string =>
  entries
    .map((e) =>
      JSON.stringify({
        transcriptId: e.transcriptId,
        callId: e.callId,
        carrierCallId: e.carrierCallId,
        offsetMs: e.offsetMs,
        provider: e.provider,
        confidence: e.confidence,
        heard: e.heard,
        corrected: e.corrected,
        wer: wordErrorRate(e.heard, e.corrected),
        correctedAt: e.correctedAt.toISOString(),
      }),
    )
    .join("\n");
