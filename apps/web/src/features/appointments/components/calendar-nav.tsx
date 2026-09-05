import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { buttonClass } from "@/components/ui";
import { cn } from "@/lib/cn";

import {
  CALENDAR_VIEWS,
  VIEW_LABELS,
  rangeTitle,
  stepAnchor,
  type CalendarView,
} from "../appointments.range";
import { isoDate, todayIn, type PlainDate } from "../appointments.time";

/**
 * Move around the calendar, and say what is on screen.
 *
 * Day, week, month, back, forward and today are all plain links carrying
 * `?calendar=&view=&date=`, so every one of them is a real URL the back button understands and
 * a view is something you can send someone. Nothing here is client state, which is why the
 * page can stay a server component and the grid can be handed finished data.
 *
 * The step buttons mean different amounts in different views — a day, a week, a month — and
 * `stepAnchor` owns that so the arrows never have to know which view they are under.
 */
export const CalendarNav = ({
  calendarId,
  view,
  anchor,
  timeZone,
  showWeekends,
}: {
  readonly calendarId: string;
  readonly view: CalendarView;
  readonly anchor: PlainDate;
  readonly timeZone: string;
  readonly showWeekends: boolean;
}) => {
  const weekendSuffix = showWeekends ? "" : "&weekends=0";
  const href = (next: CalendarView, date: PlainDate): string =>
    `/appointments?calendar=${encodeURIComponent(calendarId)}&view=${next}&date=${isoDate(date)}${weekendSuffix}`;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1">
        <Link
          href={href(view, stepAnchor(view, anchor, -1))}
          aria-label={`Previous ${view}`}
          className={buttonClass("secondary", "sm", "px-2")}
        >
          <ChevronLeft aria-hidden className="size-4" />
        </Link>
        <Link
          href={href(view, stepAnchor(view, anchor, 1))}
          aria-label={`Next ${view}`}
          className={buttonClass("secondary", "sm", "px-2")}
        >
          <ChevronRight aria-hidden className="size-4" />
        </Link>
      </div>

      <Link href={href(view, todayIn(timeZone))} className={buttonClass("secondary", "sm")}>
        Today
      </Link>

      <div className="text-[13.5px] font-medium tabular-nums">{rangeTitle(view, anchor)}</div>

      {/* Only the grid views have weekend columns to hide; offering the switch on a day or an
          agenda would be a control that does nothing. */}
      {(view === "week" || view === "month") && (
        <Link
          href={`/appointments?calendar=${encodeURIComponent(calendarId)}&view=${view}&date=${isoDate(anchor)}${showWeekends ? "&weekends=0" : ""}`}
          className={buttonClass("secondary", "sm")}
        >
          {showWeekends ? "Hide weekends" : "Show weekends"}
        </Link>
      )}

      {/* The segmented control keeps the anchor, so switching view stays on the day you were
          looking at rather than jumping back to today. */}
      <div className="ml-auto flex items-center rounded-lg border border-[var(--hairline)] p-0.5">
        {CALENDAR_VIEWS.map((option) => (
          <Link
            key={option}
            href={href(option, anchor)}
            aria-current={option === view ? "page" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors",
              option === view
                ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                : "text-[var(--ink-3)] hover:text-[var(--ink-1)]",
            )}
          >
            {VIEW_LABELS[option]}
          </Link>
        ))}
      </div>
    </div>
  );
};
