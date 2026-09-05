import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * How far through a campaign is, as a bar and a figure.
 *
 * One component and two callers — the card on the list and the state panel on the campaign's
 * own page. They were going to draw the same bar, and two copies of this arithmetic is two
 * places for "done" to come to mean different things.
 *
 * "Done" is total minus pending rather than answered: a call that rang out, hit voicemail or
 * was suppressed is finished with, and counting only answers would leave a campaign that has
 * dialled everybody sitting at 40% forever. Answered is reported separately, because it is
 * the number somebody actually cares about and it says something different.
 *
 * A campaign with nobody on it draws no bar at all. Zero of zero is not 0% and not 100%, and
 * drawing either would be inventing a fact about an empty list.
 *
 * Plain numbers rather than a campaign object, because the two callers hold different types:
 * the list item and the detail response are generated separately and only happen to agree on
 * these counts.
 */
export const CampaignProgress = ({
  pending,
  total,
  empty,
  className,
}: {
  readonly pending: number;
  readonly total: number;
  /** What stands in for the bar when there is nobody to call. */
  readonly empty?: ReactNode;
  readonly className?: string;
}) => {
  if (total === 0) {
    return (
      <p className={cn("text-[12px] text-[var(--ink-3)]", className)}>
        {empty ?? "Nobody on it yet — add contacts to give it something to dial."}
      </p>
    );
  }

  const settled = total - pending;
  const percent = Math.round((settled / total) * 100);

  return (
    <div className={className}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-[var(--ink-3)]">
          {settled} of {total} called
        </span>
        <span className="text-[12px] tabular-nums text-[var(--ink-3)]">{percent}%</span>
      </div>
      <div
        /* `--hairline`, not `--surface-2`. The track has to stay visible against the card it
           sits on in both themes, and `--surface-2` is white at 60% in light mode — an
           invisible track on a white card, which reads as a bar that is always at 100%. */
        className="h-1.5 overflow-hidden rounded-full bg-[var(--hairline)]"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${settled} of ${total} called`}
      >
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};
