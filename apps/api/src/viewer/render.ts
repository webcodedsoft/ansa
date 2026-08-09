import type { CallDetail, CallSummary, CorpusEntry, DeliveryRecord } from "@ansa/db";

import type { alertsFor } from "./alerts";
import type { CallCost } from "./cost";
import { wordErrorRate, type QualityMetrics } from "./metrics";
import type { ReviewScore } from "./review";
import type { CaptureCase, KeytermCandidate } from "./suggestions";
import type { ConfigVersionTrend } from "./trends";

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

/**
 * Each segment is encoded separately, so a path can have more than one.
 *
 * `encodeURIComponent` over the whole path turns the slash in `id/claim.json` into `%2F`
 * and the link 404s — the id is still a path parameter and still needs encoding, so the
 * fix is per segment rather than dropping the encoding.
 */
const href = (link: ViewerLink, path = ""): string =>
  `/viewer${path === "" ? "" : `/${path.split("/").map(encodeURIComponent).join("/")}`}` +
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

/**
 * The one navigation line, so a page added here appears on every other page.
 *
 * The review queue leads, because it is the page a reviewer opens; the call list is where
 * you end up when you already know which call you want.
 */
const nav = (link: ViewerLink, here: string): string => {
  const items: readonly (readonly [string, string])[] = [
    ["", "calls"],
    ["review", "review queue"],
    ["metrics", "metrics"],
    ["suggestions", "suggestions"],
    ["corpus", "corpus"],
    ["corpus.jsonl", "corpus (jsonl)"],
    ["deliveries", "event deliveries"],
  ];
  return `<p>${items
    .filter(([path]) => path !== here)
    .map(([path, label]) => `<a href="${esc(href(link, path))}">${esc(label)}</a>`)
    .join(" · ")}</p>`;
};

export const renderCallList = (calls: readonly CallSummary[], link: ViewerLink): string =>
  page(
    "Calls",
    `<h1>Calls</h1>` +
      nav(link, "") +
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
      // The corrections on this call, in the format `eval/verdict.py` reads. Offered per
      // call rather than in bulk because a claim file is about one recording, and because
      // saving it is the moment a reviewer decides this call is worth keeping.
      `<p><a href="${esc(href(link, `${s.id}/claim.json`))}">claim.json</a> ` +
      `<span class=muted>— save into eval/claims/ and score a candidate against it</span></p>` +
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
  /** What the numbers above say is wrong, and what the calls cost. Both read the same log. */
  breaches: ReturnType<typeof alertsFor>,
  cost: CallCost,
  /** The same numbers again, split by the configuration that served each call (R9.2.6). */
  trends: readonly ConfigVersionTrend[],
): string => {
  const row = (name: string, value: string, meaning: string): string =>
    `<tr><td>${esc(name)}<td class=num>${esc(value)}<td class=muted>${esc(meaning)}</tr>`;

  /**
   * Above the scoreboard, deliberately. Something being wrong is not a row in a table of
   * fourteen rows — it is the reason the page was opened.
   */
  const alarms = breaches.sampleTooSmall
    ? `<p class=muted>Too few calls in the window to judge anything. Thresholds are held ` +
      `until there are enough.</p>`
    : breaches.alerts.length === 0
      ? `<p class=good>Every threshold met.</p>`
      : `<table><tr><th>Breached<th>Now<th>Threshold<th>What it means</tr>` +
        breaches.alerts
          .map(
            (a) =>
              `<tr><td class=warn>${esc(a.name)}` +
              `<td class="num warn">${esc(a.unit === "ms" ? ms(a.observed) : percent(a.observed))}` +
              `<td class=num>${esc(a.unit === "ms" ? ms(a.threshold) : percent(a.threshold))}` +
              `<td class=muted>${esc(a.meaning)}</tr>`,
          )
          .join("") +
        `</table>`;

  const money = (amount: number | null): string =>
    amount === null ? "—" : `${cost.currency} ${amount.toFixed(4)}`.trim();

  const spend =
    `<table><tr><th>Component<th>Used<th>Cost<th>Note</tr>` +
    cost.lines
      .map(
        (l) =>
          `<tr><td>${esc(l.label)}` +
          `<td class=num>${esc(Math.round(l.quantity))} ${esc(l.unit)}` +
          `<td class=num>${esc(money(l.amount))}` +
          `<td class=muted>${esc(l.note)}</tr>`,
      )
      .join("") +
    `<tr><td><b>Total</b><td class=num>${esc(window.calls)} calls` +
    `<td class=num><b>${esc(money(cost.total))}</b>` +
    `<td class=muted>${esc(
      cost.total === null
        ? "held back until every component can be priced — a partial total is not a number"
        : `${money(cost.perCall)} per call`,
    )}</tr></table>`;

  /**
   * Movement, by the configuration that served it (R9.2.6).
   *
   * One row per `calls.config_version` in the window. It is deliberately spare — flagged
   * rate, correction rate, latency, transfer — because the question it answers is "did
   * anything move", and fourteen columns per version answers that worse than four.
   *
   * A version with a handful of calls is left in rather than hidden, with its call count
   * next to it, because the alternative is a rollout looking like it had no effect for the
   * first hour. Reading a rate off three calls is the reader's mistake to avoid, and the
   * denominator is right there.
   */
  const trend =
    trends.length === 0
      ? `<p class=muted>No calls in the window.</p>`
      : `<table><tr><th>Config<th>Calls<th>Flagged<th>Severity/call<th>Corrections` +
        `<th>Latency p50<th>Transfers<th>First<th>Last</tr>` +
        trends
          .map(
            (t) =>
              `<tr><td>${esc(t.configVersion === null ? "not recorded" : `v${t.configVersion}`)}` +
              `<td class=num>${esc(t.calls)}` +
              `<td class=num>${esc(percent(t.flaggedRate))}` +
              `<td class=num>${esc(t.severityPerCall === null ? "—" : t.severityPerCall.toFixed(1))}` +
              `<td class=num>${esc(percent(t.metrics.correctionRate))}` +
              `<td class=num>${esc(ms(t.metrics.responseLatencyMs.p50))}` +
              `<td class=num>${esc(percent(t.metrics.transferRate))}` +
              `<td class=muted>${esc(t.firstCallAt)}` +
              `<td class=muted>${esc(t.lastCallAt)}</tr>`,
          )
          .join("") +
        `</table>`;

  return page(
    "Metrics",
    nav(link, "metrics") +
      `<h1>Thresholds</h1>` +
      alarms +
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
      row(
        "Silence recovered",
        percent(metrics.recoveryRate),
        `caller turns that produced nothing and needed an apology (${metrics.recoveryLines} of them)`,
      ) +
      row(
        "Tool failure rate",
        percent(metrics.toolFailureRate),
        `tool calls that timed out or errored (${metrics.toolCalls} dispatched)`,
      ) +
      `</table>` +
      `<h1>By configuration version</h1>` +
      `<p class=muted>Which version of the tenant's configuration served each call (R7.5). ` +
      `Movement between versions is evidence that something changed, not evidence of what: ` +
      `provider, model and endpointing are deployment settings and do not appear here. Each ` +
      `call's own settings are in its claim file.</p>` +
      trend +
      `<h1>Cost</h1>` +
      `<p class=muted>Usage is measured; prices are whatever this deployment was ` +
      `configured with. An unpriced line means no rate is set for it, never that it is free.</p>` +
      spend,
  );
};

/**
 * The review queue (R9.2.2) — the page this whole slice exists to put in front of someone.
 *
 * Ranked by severity, and every row carries the signals that produced its number. A queue
 * that says only "this call scored 14" makes a reviewer open it to find out why; a queue
 * that says "two hallucinations, capture fell to the keypad" lets them decide not to.
 */
export const renderReviewQueue = (
  queue: readonly ReviewScore[],
  link: ViewerLink,
  window: { readonly calls: number },
): string =>
  page(
    "Review queue",
    `<h1>Review queue</h1>` +
      nav(link, "review") +
      `<p class=muted>Over the last ${esc(window.calls)} calls, ${esc(queue.length)} flagged. ` +
      `Severity orders the list and means nothing else: a call at 20 is opened before a call ` +
      `at 8, and two calls at 8 are equally next rather than equally bad.</p>` +
      (queue.length === 0
        ? `<p class=good>Nothing flagged in this window.</p>`
        : `<table><tr><th>Sev<th>When<th>Call<th>Ended<th>Reviewed<th>Why</tr>` +
          queue
            .map(
              (score) =>
                `<tr><td class="num warn">${esc(score.severity)}` +
                `<td>${esc(score.createdAt)}` +
                `<td><a href="${esc(href(link, score.callId))}">${esc(score.carrierCallId)}</a>` +
                `<td>${esc(score.endReason ?? "in progress")}` +
                `<td class=num>${esc(score.reviewed)}/${esc(score.reviewed + score.unreviewed)}` +
                `<td>` +
                score.signals
                  .map(
                    (signal) =>
                      `<div><b>${esc(signal.kind)}</b>` +
                      `${signal.count > 1 ? esc(` ×${signal.count}`) : ""} ` +
                      `<span class=muted>${esc(signal.why)}</span></div>`,
                  )
                  .join("") +
                `</tr>`,
            )
            .join("") +
          `</table>`),
  );

/**
 * What the corrections are evidence for, and what nobody has approved yet (R9.2.5).
 *
 * There is no button on this page and that is the design. `apps/api/src/tenancy/defaults.ts`
 * records that boosting a list of ordinary domain words — with no personal name in it —
 * deterministically turned a caller's name into a different name. A human reads this and
 * edits the tenant's keyterms through the configuration API if they agree.
 */
export const renderSuggestions = (
  keyterms: readonly KeytermCandidate[],
  captures: readonly CaptureCase[],
  link: ViewerLink,
  known: readonly string[],
): string =>
  page(
    "Suggestions",
    `<h1>Suggestions</h1>` +
      nav(link, "suggestions") +
      `<p class=warn>Nothing on this page has been applied, and nothing on it will be. ` +
      `Boosting a keyterm is a bias, not a hint: a listed token wins ties against every ` +
      `token nobody listed. Measured on 2026-08-08, three deterministic runs each way, a ` +
      `domain-word list with no personal name in it turned "Sikiru" into "Akiro". Approve ` +
      `these one at a time, through the configuration API.</p>` +
      `<h2>Keyterm candidates</h2>` +
      `<p class=muted>Words a reviewer put back that the transcriber never produced, on at ` +
      `least two separate calls. Already carried: ${esc(known.join(", ") || "nothing")}.</p>` +
      (keyterms.length === 0
        ? `<p class=muted>Nothing repeated across two calls yet.</p>`
        : `<table><tr><th>Term<th>Calls<th>Note<th>Evidence</tr>` +
          keyterms
            .map(
              (candidate) =>
                `<tr><td>${esc(candidate.term)}` +
                `<td class=num>${esc(candidate.calls)}` +
                `<td class=${candidate.looksLikeAName ? "warn" : "muted"}>${esc(
                  candidate.looksLikeAName
                    ? "reads as a personal name — a shared vocabulary is the wrong home for one"
                    : "",
                )}` +
                `<td>` +
                candidate.evidence
                  .map(
                    (e) =>
                      `<div><a href="${esc(href(link, e.callId))}">${esc(e.carrierCallId)}</a> ` +
                      `<span class=warn>${esc(e.heard)}</span> → ` +
                      `<span class=good>${esc(e.corrected)}</span></div>`,
                  )
                  .join("") +
                `</tr>`,
            )
            .join("") +
          `</table>`) +
      `<h2>Number capture cases</h2>` +
      `<p class=muted>Turns where the digits a reviewer heard are not the digits the ` +
      `transcriber produced. These are inbound capture cases (R4.3.1), not outbound ` +
      `normalizer cases — a correction is a human's transcript of what the <em>caller</em> ` +
      `said, and says nothing about how the agent pronounced anything.</p>` +
      (captures.length === 0
        ? `<p class=muted>No corrected turn has changed a digit.</p>`
        : `<table><tr><th>Call<th>Heard<th>Truth<th>Digits</tr>` +
          captures
            .map(
              (c) =>
                `<tr><td><a href="${esc(href(link, c.callId))}">${esc(c.carrierCallId)}</a>` +
                `<td class=warn>${esc(c.heard)}` +
                `<td class=good>${esc(c.corrected)}` +
                `<td class=num>${esc(c.heardDigits || "—")} → ${esc(c.correctedDigits || "—")}</tr>`,
            )
            .join("") +
          `</table>`),
  );

/**
 * The corpus, as a page a human can read before trusting the file.
 *
 * The machine-readable export is JSONL from the same query; this exists so a reviewer can
 * see what they have actually built without piping a file through jq.
 */
export const renderCorpus = (entries: readonly CorpusEntry[], link: ViewerLink): string =>
  page(
    "Corpus",
    `<h1>Eval corpus</h1>` +
      nav(link, "corpus") +
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

/**
 * The event delivery log (Slice 6a).
 *
 * The question this page exists to answer is not "did a request happen" but "what did you
 * send me, and when". So the body is here, in full, rather than a status code and a
 * shrug — it is the bytes that were signed and posted, which is the only thing that
 * settles the argument.
 *
 * It is a transcript, so it is escaped like everything else on this tool and served with
 * the same no-store headers.
 */
export const renderDeliveries = (
  deliveries: readonly DeliveryRecord[],
  link: ViewerLink,
): string =>
  page(
    "Event deliveries",
    `<h1>Event deliveries</h1>` +
      nav(link, "deliveries") +
      (deliveries.length === 0
        ? "<p class=muted>Nothing queued. No receiver is configured for this tenant, " +
          "or no call has ended since one was.</p>"
        : `<table><tr><th>Queued<th>Event<th>To<th>Call<th>Cfg<th>Status<th>Tries<th>Last<th>Sent</tr>` +
          deliveries
            .map((d) => {
              const tone =
                d.status === "delivered" ? "good" : d.status === "failed" ? "warn" : "muted";
              const last =
                d.status === "delivered"
                  ? `${d.lastStatus ?? ""}`
                  : `${d.lastStatus ?? ""} ${d.lastError ?? ""}`.trim();
              return (
                `<tr><td>${esc(d.createdAt.toISOString())}` +
                `<td>${esc(d.eventType)}` +
                `<td>${esc(d.subscription)}` +
                `<td>${esc(d.carrierCallId ?? "—")}` +
                `<td class=num>${esc(d.configVersion ?? "—")}` +
                `<td class=${tone}>${esc(d.status)}` +
                `<td class=num>${esc(d.attempts)}` +
                `<td>${esc(last === "" ? "—" : last)}` +
                `<td><details><summary>body</summary><pre>${esc(d.body ?? "")}</pre></details></tr>`
              );
            })
            .join("") +
          `</table>`),
  );
