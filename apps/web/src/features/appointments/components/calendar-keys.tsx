"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { VIEW_KEYS, stepAnchor, type CalendarView } from "../appointments.range";
import { isoDate, todayIn, type PlainDate } from "../appointments.time";

/**
 * The keyboard shortcuts a daily operator lives on.
 *
 * `D`, `W`, `M` and `A` switch view and `T` goes to today — the same letters Google uses, so
 * anyone who has kept a calendar before already knows them. The arrows step by whatever the
 * current view steps by, which is the same `stepAnchor` the buttons use rather than a second
 * copy of that rule.
 *
 * Renders nothing. It exists because the page around it is a server component and a key press
 * is not something a server component can hear.
 *
 * Two guards keep it from firing when it should not: a modifier means the key belongs to the
 * browser or the operating system, and a press inside a field, a select or anything a person
 * is editing belongs to that field — without the second, typing "Wednesday viewing" into the
 * title box would change the view four times and lose the dialog.
 */
export const CalendarKeys = ({
  calendarId,
  view,
  anchor,
  timeZone,
}: {
  readonly calendarId: string;
  readonly view: CalendarView;
  readonly anchor: PlainDate;
  readonly timeZone: string;
}) => {
  const router = useRouter();

  useEffect(() => {
    const go = (next: CalendarView, date: PlainDate): void => {
      router.push(
        `/appointments?calendar=${encodeURIComponent(calendarId)}&view=${next}&date=${isoDate(date)}`,
      );
    };

    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }

      const key = event.key.toLowerCase();
      const asView = VIEW_KEYS[key];
      if (asView !== undefined) {
        event.preventDefault();
        go(asView, anchor);
        return;
      }
      if (key === "t") {
        event.preventDefault();
        go(view, todayIn(timeZone));
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        go(view, stepAnchor(view, anchor, event.key === "ArrowRight" ? 1 : -1));
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, calendarId, view, anchor, timeZone]);

  return null;
};
