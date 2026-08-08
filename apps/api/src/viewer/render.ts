import type { CallDetail, CallSummary } from "@ansa/db";

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
  </style></head><body>${body}</body></html>`;

export const renderCallList = (calls: readonly CallSummary[], link: ViewerLink): string =>
  page(
    "Calls",
    `<h1>Calls</h1>` +
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
  const rows = [
    ...call.transcripts.map((t) => ({
      offsetMs: t.offsetMs,
      kind: "caller said",
      body:
        `<span class=caller>${esc(t.correctedText ?? t.text)}</span>` +
        (t.correctedText === null ? "" : `<br><span class=muted>heard: ${esc(t.text)}</span>`) +
        `<br><span class=muted>${esc(t.provider)}` +
        (t.confidence === null ? "" : ` · confidence ${esc(t.confidence.toFixed(2))}`) +
        `</span>`,
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
