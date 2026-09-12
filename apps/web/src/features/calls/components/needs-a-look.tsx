import { Card, Tag } from "@/components/ui";

import type { CallDetail } from "../calls.service";

/**
 * The lines a person should check.
 *
 * Low confidence on a caller's line is where a mishearing hides — "a barn" for "Ibadan", a
 * digit dropped from a phone number — and the transcript shows every line the same way, so
 * the one worth checking looks like the forty that are fine. This card counts them and says
 * why they matter: a correction feeds the organisation's keyterms and the eval corpus, with a
 * person deciding, never automatically.
 *
 * The bar is `UNCERTAIN_BELOW` from `orchestrator/capture.ts`, 0.7 — the same line the agent
 * uses to decide whether to read a value back. Two thresholds for "unsure" would mean the
 * agent checking a line the console then called fine, or the reverse.
 */
export const UNCERTAIN_BELOW = 0.7;

export const isUncertain = (line: { readonly confidence: string | null }): boolean =>
  line.confidence !== null && Number(line.confidence) < UNCERTAIN_BELOW;

export const lowConfidenceLines = (call: CallDetail): readonly CallDetail["transcripts"][number][] =>
  call.transcripts.filter(
    (line) => line.speaker !== "agent" && line.correctedText === null && isUncertain(line),
  );

export const NeedsALook = ({ call }: { readonly call: CallDetail }) => {
  const lines = lowConfidenceLines(call);
  const lowest = lines.reduce<number | null>(
    (min, line) => (min === null ? Number(line.confidence) : Math.min(min, Number(line.confidence))),
    null,
  );

  return (
    <Card title="Needs a look">
      {lines.length === 0 ? (
        <p className="m-0 text-[12.5px] text-[var(--ink-3)]">
          Nothing flagged. Every line the caller said came back above the confidence the agent
          reads values back at, or has already been corrected.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          <Tag tone="warn">
            {lines.length} low-confidence {lines.length === 1 ? "line" : "lines"}
          </Tag>
          <p className="m-0 text-[12.5px] leading-relaxed text-[var(--ink-3)]">
            {lines.length === 1 ? "One line" : `${lines.length} lines`} the caller said came back
            below {UNCERTAIN_BELOW}
            {lowest === null ? "" : ` — the lowest at ${lowest.toFixed(2)}`}. Each is marked in
            the conversation with a Correct this control. Correcting it feeds this organisation&apos;s
            keyterms and the eval corpus — with a person deciding, never automatically.
          </p>
        </div>
      )}
    </Card>
  );
};
