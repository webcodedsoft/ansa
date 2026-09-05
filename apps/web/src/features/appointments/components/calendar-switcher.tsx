"use client";

import { useRouter } from "next/navigation";

import { CONTROL } from "@/components/ui";

import type { CalendarSummary } from "../appointments.service";

/**
 * Choose which calendar the page is showing.
 *
 * The selection lives in the URL (`?calendar=`), like every other list-state in this app, so a
 * view of one calendar's week is a link somebody can send and the back button returns to the
 * calendar you were on. The week param is deliberately dropped on a switch: two calendars can
 * sit in different timezones, so "the same week" is not the same instants, and carrying the
 * anchor across would land the reader on an arbitrary week of the new calendar. Today is the
 * honest default.
 */
export const CalendarSwitcher = ({
  calendars,
  selectedId,
}: {
  readonly calendars: readonly CalendarSummary[];
  readonly selectedId: string;
}) => {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">Calendar</span>
      <select
        className={CONTROL}
        value={selectedId}
        onChange={(event) => router.push(`/appointments?calendar=${encodeURIComponent(event.target.value)}`)}
      >
        {calendars.map((calendar) => (
          <option key={calendar.id} value={calendar.id}>
            {calendar.name}
          </option>
        ))}
      </select>
    </label>
  );
};
