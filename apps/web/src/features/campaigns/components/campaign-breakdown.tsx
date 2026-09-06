import { Tag } from "@/components/ui";

import { callStatusLabel, callTone } from "../campaigns.display";
import type { ScheduledCallStatus } from "../campaigns.service";

/** The order a reader wants them in: finished well, finished badly, not finished. */
const STATUS_ORDER: readonly ScheduledCallStatus[] = [
  "answered",
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "suppressed",
  "placing",
  "pending",
];

/** The bar's colours, taken from the same tones the table's tags use. */
const TONE_COLOUR: Readonly<Record<string, string>> = {
  accent: "var(--accent)",
  ok: "var(--ok)",
  warn: "var(--warn)",
  bad: "var(--bad)",
  neutral: "var(--ink-3)",
};

interface Part {
  readonly key: string;
  readonly label: string;
  readonly n: number;
  readonly colour: string;
}

const Segments = ({ parts }: { readonly parts: readonly Part[] }) => {
  const total = parts.reduce((sum, part) => sum + part.n, 0);
  if (total === 0) return null;

  return (
    <div className="flex h-2 overflow-hidden rounded-full">
      {parts.map((part) => (
        <div
          key={part.key}
          title={`${part.label}: ${part.n}`}
          style={{ width: `${(part.n / total) * 100}%`, background: part.colour }}
        />
      ))}
    </div>
  );
};

const Legend = ({ parts }: { readonly parts: readonly Part[] }) => (
  <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
    {parts.map((part) => (
      <li key={part.key} className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="size-2 flex-none rounded-full"
          style={{ background: part.colour }}
        />
        <span className="text-[12px] text-[var(--ink-2)]">{part.label}</span>
        <span className="text-[12px] tabular-nums text-[var(--ink)]">{part.n}</span>
      </li>
    ))}
  </ul>
);

/**
 * How a campaign turned out, rather than how far through it is.
 *
 * The progress bar answers "are we done". These answer "did it work", which is the question a
 * campaign exists to have answered and which nothing on this page could reach before: the
 * detail response carried `pending`, `answered` and `total`, with no way to tell a voicemail
 * from an engaged tone from a number the consent gate refused.
 *
 * Two bars, because they measure different things and one bar would be nonsense. What the
 * dialler did is one fact per row and always sums to the total. What the call came to is the
 * agent's recorded verdict, which is only ever a subset — a call that rang out has a status
 * and no verdict — so it gets its own bar over its own total, captioned with what that total
 * is so the smaller bar cannot be misread as a smaller campaign.
 *
 * A status nothing reached is absent rather than a zero segment. "Nobody was suppressed" and
 * "suppression never came up" are different facts that a zero would render identically, and
 * an empty segment in a stacked bar is a rounding artefact waiting to happen.
 */
export const CampaignBreakdown = ({
  byStatus,
  byOutcome,
}: {
  readonly byStatus: Readonly<Record<string, number>>;
  readonly byOutcome: Readonly<Record<string, number>>;
}) => {
  const statusParts: readonly Part[] = STATUS_ORDER.filter(
    (status) => (byStatus[status] ?? 0) > 0,
  ).map((status) => ({
    key: status,
    /* Fallbacks rather than assertions. `noUncheckedIndexedAccess` is on, and a status the
       maps do not cover should render as its own name in grey rather than crash a panel. */
    label: callStatusLabel[status] ?? status,
    n: byStatus[status] ?? 0,
    colour: TONE_COLOUR[callTone[status] ?? "neutral"] ?? "var(--ink-3)",
  }));

  /* The organisation's own words, so there is no order to know and no palette to map. Biggest
     first, which is the only ranking that means anything when the names are arbitrary. */
  const outcomeParts: readonly Part[] = Object.entries(byOutcome)
    .filter(([, n]) => n > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([name, n], index) => ({
      key: name,
      label: name,
      n,
      colour: index === 0 ? "var(--accent)" : "var(--ink-3)",
    }));

  const dialled = statusParts.reduce((sum, part) => sum + part.n, 0);
  const verdicts = outcomeParts.reduce((sum, part) => sum + part.n, 0);

  if (statusParts.length === 0) {
    return (
      <p className="text-[12.5px] text-[var(--ink-3)]">
        Nothing has been dialled yet, so there is nothing to break down.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="mb-2 text-[11px] tracking-[0.06em] text-[var(--ink-3)] uppercase">
          What the dialler did
        </div>
        <Segments parts={statusParts} />
        <Legend parts={statusParts} />
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
          <span className="text-[11px] tracking-[0.06em] text-[var(--ink-3)] uppercase">
            What the calls came to
          </span>
          {verdicts > 0 && (
            <span className="text-[11.5px] text-[var(--ink-3)]">
              {verdicts} of {dialled} recorded a verdict
            </span>
          )}
        </div>
        {outcomeParts.length === 0 ? (
          <p className="text-[12.5px] leading-relaxed text-[var(--ink-3)]">
            No verdict recorded yet. The agent picks one from this campaign&apos;s own list at
            the end of a call, so a campaign with none written down will never fill this in —
            that is <span className="text-[var(--ink-2)]">What counts as done</span> on the
            Brief tab.
          </p>
        ) : (
          <>
            <Segments parts={outcomeParts} />
            <Legend parts={outcomeParts} />
          </>
        )}
      </div>

      {(byStatus["suppressed"] ?? 0) > 0 && (
        <div className="flex flex-wrap items-start gap-2.5 border-t border-[var(--hairline)] pt-4">
          <Tag tone="bad">{byStatus["suppressed"]} suppressed</Tag>
          <p className="min-w-[240px] flex-1 text-[12px] leading-relaxed text-[var(--ink-3)]">
            Calls the consent gate would not place — a do-not-call entry, withdrawn consent, or
            the hour. Not failures, and never dialled. The reason for each one is in the
            &ldquo;What came of it&rdquo; column on the Calls tab.
          </p>
        </div>
      )}
    </div>
  );
};
