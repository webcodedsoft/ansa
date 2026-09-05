import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { buttonClass } from "@/components/ui";
import {
  addDays,
  isoDate,
  mondayOf,
  todayIn,
  weekDays,
  type PlainDate,
} from "../appointments.time";

/**
 * Move between weeks, and say which week is on screen.
 *
 * Prev, next and today are plain links carrying `?calendar=&week=`, so navigation is a real
 * URL change the back button understands rather than client state that a refresh would lose.
 * The week label names the calendar's Monday-to-Sunday span in the calendar's own zone, so a
 * reader is never guessing which seven days these are.
 */
export const WeekNav = ({
  calendarId,
  anchor,
  timeZone,
}: {
  readonly calendarId: string;
  readonly anchor: PlainDate;
  readonly timeZone: string;
}) => {
  const days = weekDays(anchor);
  const first = days[0]?.date ?? anchor;
  const last = days[days.length - 1]?.date ?? anchor;
  const monday = mondayOf(anchor);
  const prev = isoDate(addDays(monday, -7));
  const next = isoDate(addDays(monday, 7));
  const today = isoDate(todayIn(timeZone));

  const href = (week: string): string =>
    `/appointments?calendar=${encodeURIComponent(calendarId)}&week=${week}`;

  const format = (date: PlainDate, withYear: boolean): string =>
    new Intl.DateTimeFormat("en-NG", {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    }).format(new Date(Date.UTC(date.year, date.month - 1, date.day)));

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1">
        <Link href={href(prev)} aria-label="Previous week" className={buttonClass("secondary", "sm", "px-2")}>
          <ChevronLeft aria-hidden className="size-4" />
        </Link>
        <Link href={href(next)} aria-label="Next week" className={buttonClass("secondary", "sm", "px-2")}>
          <ChevronRight aria-hidden className="size-4" />
        </Link>
      </div>
      <Link href={href(today)} className={buttonClass("secondary", "sm")}>
        Today
      </Link>
      <div className="text-[13.5px] font-medium tabular-nums">
        {format(first, false)} – {format(last, true)}
      </div>
    </div>
  );
};
