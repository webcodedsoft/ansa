"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui";

import type { CalendarView as ViewKind } from "../appointments.range";
import type { BookingView, DayColumn, DraftSpan, MonthCell } from "../appointments.view";
import { AppointmentDialog, type DialogTarget } from "./appointment-dialog";
import { MonthGrid } from "./month-grid";
import { TimeGrid } from "./time-grid";

/**
 * The calendar, and the one dialog everything on it opens.
 *
 * The only client component in the stack, and it exists for one reason: which appointment is
 * open is state, and state cannot live in a server component. Everything it draws — the days,
 * the placement, the range — was computed on the server and arrives finished, so this holds a
 * single `target` and nothing else.
 *
 * Day and week are the same grid with a different number of columns; month is its own, because
 * a month cell is a list rather than a clock. All three open the same dialog, so an appointment
 * behaves identically wherever it was clicked.
 */
export const CalendarBoard = ({
  calendarId,
  view,
  days,
  cells,
  startMinute,
  endMinute,
  timeZone,
  slotMinutes,
  hasHours,
  canWrite,
}: {
  readonly calendarId: string;
  readonly view: ViewKind;
  readonly days: readonly DayColumn[];
  readonly cells: readonly (readonly MonthCell[])[];
  readonly startMinute: number;
  readonly endMinute: number;
  readonly timeZone: string;
  readonly slotMinutes: number;
  readonly hasHours: boolean;
  readonly canWrite: boolean;
}) => {
  const [target, setTarget] = useState<DialogTarget>(null);

  /* Built here rather than handed down: a server component cannot pass a function across the
     boundary, and the link only ever needs the calendar it is already given. */
  const dayHref = (iso: string): string =>
    `/appointments?calendar=${encodeURIComponent(calendarId)}&view=day&date=${iso}`;

  const openBooking = (booking: BookingView): void =>
    setTarget({ kind: "existing", booking });
  const openSpan = (span: DraftSpan): void => setTarget({ kind: "new", span });

  /** A day with no gesture behind it: one normal-length appointment at the top of the day. */
  const addOn = (dayIso: string): void =>
    openSpan({
      dayIso,
      startMinute,
      endMinute: Math.min(startMinute + slotMinutes, endMinute),
    });

  /* "Add appointment" needs a day, and in the month view the anchor day is the honest choice —
     the first day of the period on screen that is actually in it. */
  const firstDay = view === "month" ? (cells.flat().find((cell) => cell.inMonth)?.iso ?? null) : (days[0]?.iso ?? null);

  return (
    <div className="flex flex-col gap-3">
      {canWrite && firstDay !== null && (
        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={() => addOn(firstDay)}>
            <Plus aria-hidden className="size-3.5" />
            Add appointment
          </Button>
        </div>
      )}

      {view === "month" ? (
        <MonthGrid
          weeks={cells}
          canWrite={canWrite}
          dayHref={dayHref}
          onOpenBooking={openBooking}
          onAddOn={addOn}
        />
      ) : (
        <TimeGrid
          days={days}
          startMinute={startMinute}
          endMinute={endMinute}
          timeZone={timeZone}
          slotMinutes={slotMinutes}
          hasHours={hasHours}
          canWrite={canWrite}
          onOpenBooking={openBooking}
          onDraft={openSpan}
        />
      )}

      <AppointmentDialog
        calendarId={calendarId}
        target={target}
        timeZone={timeZone}
        canWrite={canWrite}
        onClose={() => setTarget(null)}
      />
    </div>
  );
};
