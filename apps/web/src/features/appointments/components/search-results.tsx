import Link from "next/link";

import { Tag } from "@/components/ui";
import { buttonClass } from "@/components/ui";

/** One match, with everything already rendered — the page owns the timezone arithmetic. */
export interface SearchHit {
  readonly id: string;
  readonly label: string;
  readonly when: string;
  readonly calendarName: string;
  readonly status: "held" | "booked";
  readonly href: string;
}

/**
 * What the search found, across every calendar the organisation keeps.
 *
 * Deliberately not the grid. A result's value is *when* it is, and a match three months out
 * would need three months of grid drawn around it to be seen at all; a list says the date
 * outright and links to the day it is on, which is where you go to do anything about it.
 *
 * Results span calendars, so each row names its own — two calendars may both hold a "second
 * viewing" and the answer is useless without saying which diary it is in. Each row's time is
 * read in *that* calendar's zone, which is why the strings arrive rendered rather than as
 * instants this component would have to guess about.
 */
export const SearchResults = ({
  query,
  hits,
  clearHref,
}: {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly clearHref: string;
}) => (
  <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[13px] text-[var(--ink-2)]">
        {hits.length === 0 ? (
          <>
            Nothing matches <span className="font-medium">{query}</span>.
          </>
        ) : (
          <>
            {hits.length} {hits.length === 1 ? "appointment" : "appointments"} matching{" "}
            <span className="font-medium">{query}</span>
          </>
        )}
      </p>
      <Link href={clearHref} className={buttonClass("secondary", "sm")}>
        Back to the calendar
      </Link>
    </div>

    {hits.length === 0 ? (
      <div className="surface rounded-xl px-4 py-10 text-center">
        <p className="text-[13.5px] font-medium">No appointment by that name.</p>
        <p className="mt-1 text-[12.5px] text-[var(--ink-3)]">
          Search looks at what an appointment is called and its note, across every calendar.
          Cancelled ones are not included.
        </p>
      </div>
    ) : (
      <div className="surface divide-y divide-[var(--surface-line)] overflow-hidden rounded-xl">
        {hits.map((hit) => (
          <Link
            key={hit.id}
            href={hit.href}
            className="flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-[var(--surface-2)]"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium">{hit.label}</span>
              <span className="block text-[12px] text-[var(--ink-3)]">
                {hit.when} · {hit.calendarName}
              </span>
            </span>
            {hit.status === "held" && <Tag tone="warn">held</Tag>}
          </Link>
        ))}
      </div>
    )}
  </div>
);
