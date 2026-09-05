"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";

import { addMonths, calendarRange, rangeTitle, type CalendarView } from "../appointments.range";
import { isoDate, parseIsoDate, type PlainDate } from "../appointments.time";

const HEADS: readonly string[] = ["M", "T", "W", "T", "F", "S", "S"];

/**
 * The little month in the sidebar, for getting somewhere quickly.
 *
 * Without it the only way to reach November is to press Next eight times or to edit the URL by
 * hand, which is the sort of friction that makes a calendar feel like a form. Every day is a
 * link carrying the view you are already in, so jumping to a date does not also throw away
 * whether you were reading a week or a month.
 *
 * It keeps its own idea of which month it is showing, initialised from the anchor. That is
 * deliberate and is what Google does: paging the little calendar forward to glance at December
 * should not drag the main grid along with it — you look first, then choose.
 *
 * `todayIso` is a prop rather than a read of the clock, because this renders on the server
 * first and a client that disagreed about the date would mark a different cell and trip a
 * hydration mismatch.
 */
export const MiniMonth = ({
  calendarId,
  view,
  anchor,
  timeZone,
  todayIso,
}: {
  readonly calendarId: string;
  readonly view: CalendarView;
  readonly anchor: PlainDate;
  readonly timeZone: string;
  readonly todayIso: string;
}) => {
  const [shown, setShown] = useState<PlainDate>(anchor);
  const today = parseIsoDate(todayIso) ?? anchor;
  const grid = calendarRange("month", shown, timeZone, { today });
  const anchorIso = isoDate(anchor);

  const href = (iso: string): string =>
    `/appointments?calendar=${encodeURIComponent(calendarId)}&view=${view}&date=${iso}`;

  return (
    <div className="surface rounded-xl p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12.5px] font-semibold">{rangeTitle("month", shown)}</span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setShown(addMonths(shown, -1))}
            aria-label="Previous month"
            className="rounded p-1 text-[var(--ink-3)] hover:bg-[var(--surface-2)] hover:text-[var(--ink-1)]"
          >
            <ChevronLeft aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setShown(addMonths(shown, 1))}
            aria-label="Next month"
            className="rounded p-1 text-[var(--ink-3)] hover:bg-[var(--surface-2)] hover:text-[var(--ink-1)]"
          >
            <ChevronRight aria-hidden className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {HEADS.map((label, index) => (
          <span
            key={`${label}-${index}`}
            aria-hidden
            className="py-0.5 text-center text-[10px] font-medium text-[var(--ink-3)]"
          >
            {label}
          </span>
        ))}

        {grid.days.map((day) => (
          <Link
            key={day.iso}
            href={href(day.iso)}
            aria-current={day.iso === anchorIso ? "date" : undefined}
            className={cn(
              "flex aspect-square items-center justify-center rounded-full text-[11px] tabular-nums transition-colors",
              day.inPeriod ? "text-[var(--ink-2)]" : "text-[var(--ink-3)] opacity-50",
              "hover:bg-[var(--surface-2)]",
              day.isToday && "font-semibold text-[var(--accent)]",
              day.iso === anchorIso && "bg-[var(--accent)] font-semibold text-[var(--on-accent)]",
            )}
          >
            {day.dayNumber}
          </Link>
        ))}
      </div>
    </div>
  );
};
