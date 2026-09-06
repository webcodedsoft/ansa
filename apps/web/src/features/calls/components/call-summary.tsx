"use client";

import { Card } from "@/components/ui";

import type { CallDetail } from "../calls.service";

/**
 * What the call came to, with the words behind each sentence one click away.
 *
 * **The citations are the point.** A summary a reader cannot check is a second, unverifiable
 * account of the call sitting beside the real one — and this one is written by a model. Every
 * sentence carries the transcript lines it rests on, so disagreeing with it means looking at
 * the evidence rather than arguing with the prose.
 *
 * Sentences are split on the terminators the writer produced rather than stored separately,
 * because `cites` is already one entry per sentence in the same order: two representations of
 * the same split would be one more thing to keep in step.
 *
 * A summary written without a model says so. The two read differently — one is prose, the other
 * is two quoted lines — and a reader who cannot tell which they have will trust the wrong one.
 */
export const CallSummary = ({ summary }: { readonly summary: CallDetail["summary"] }) => {
  if (summary === null) {
    return (
      <Card title="Summary">
        <p className="text-[13px] text-[var(--ink-3)]">
          Not written yet. One is added a minute or two after a call ends.
        </p>
      </Card>
    );
  }

  /* The terminator stays on the sentence it belongs to, so the text reads as written. */
  const sentences = summary.summary.split(/(?<=[.!?])\s+/).filter((one) => one.trim() !== "");

  return (
    <Card title="Summary">
      <p className="m-0 text-[13.5px] leading-relaxed">
        {sentences.map((sentence, index) => (
          <span key={`${index}-${sentence.slice(0, 12)}`}>
            {sentence}
            {(summary.cites[index] ?? []).map((id) => (
              <button
                key={id}
                type="button"
                title="Show the line this came from"
                onClick={() => {
                  /* The transcript is on this page, so the browser's own scrolling is the whole
                     implementation — no shared state between two components that only ever
                     need to agree on an id. */
                  document
                    .getElementById(`line-${id}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
                className="ml-0.5 rounded bg-[var(--accent-soft)] px-1 align-super text-[10px] font-bold text-[var(--accent)] tabular-nums hover:bg-[var(--accent)] hover:text-[var(--accent-on)]"
              >
                {id}
              </button>
            ))}{" "}
          </span>
        ))}
      </p>

      <p className="mt-3 border-t border-[var(--surface-line)] pt-2.5 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
        {summary.model === null
          ? "Written without a model — these are the caller's own first and last words, quoted. No model was reachable when this call ended."
          : `Written once when the call ended, by ${summary.model}. Click a number to see the line a sentence came from; nothing is written that cannot be pointed at.`}
      </p>
    </Card>
  );
};
