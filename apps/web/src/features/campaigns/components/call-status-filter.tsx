import Link from "next/link";

import { cn } from "@/lib/cn";

import { callStatusLabel } from "../campaigns.display";
import { SCHEDULED_STATUSES, type ScheduledCallStatus } from "../campaigns.service";

/**
 * Narrow the call list to one status.
 *
 * Links rather than buttons, and a URL rather than state. At five hundred contacts "show me
 * the failures" is the only way to use that table, and the answer is worth being able to send
 * to somebody — a filtered view living in component state cannot be linked, bookmarked or
 * reloaded, and comes back as "all" every time the page revalidates.
 *
 * Choosing a status drops back to the first page, because page four of everything is not page
 * four of the failures and staying put would land on an empty table.
 *
 * Only statuses actually present are offered. A campaign nothing has failed on does not need
 * a Failed chip leading to an empty list, and the counts come from the same breakdown the
 * panel above draws, so the two cannot disagree about how many there are.
 */
export const CallStatusFilter = ({
  basePath,
  active,
  byStatus,
  total,
}: {
  readonly basePath: string;
  readonly active: ScheduledCallStatus | null;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly total: number;
}) => {
  const present = SCHEDULED_STATUSES.filter((status) => (byStatus[status] ?? 0) > 0);
  // One status and nothing else is not a filter, it is the whole table.
  if (present.length < 2) return null;

  const chip = (on: boolean): string =>
    cn(
      "rounded-full border px-3 py-1 text-[12px] whitespace-nowrap transition-colors",
      on
        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--ink)]"
        : "border-[var(--hairline)] text-[var(--ink-3)] hover:border-[var(--ink-3)]",
    );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Link href={basePath} className={chip(active === null)}>
        All <span className="tabular-nums text-[var(--ink-3)]">{total}</span>
      </Link>
      {present.map((status) => (
        <Link key={status} href={`${basePath}?status=${status}`} className={chip(active === status)}>
          {callStatusLabel[status] ?? status}{" "}
          <span className="tabular-nums text-[var(--ink-3)]">{byStatus[status] ?? 0}</span>
        </Link>
      ))}
    </div>
  );
};
