"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui";

import type { CalendarView as ViewKind } from "../appointments.range";
import type { BookingView, DayColumn, DraftSpan, MonthCell } from "../appointments.view";
import { AppointmentDialog, type DialogTarget } from "./appointment-dialog";
import { MonthGrid } from "./month-grid";
import { QuickCreate, type Anchor } from "./quick-create";
import { ScheduleList } from "./schedule-list";
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

  /* Writing an appointment goes through the small card first. Most need a name and the time
     the click already decided, and opening a modal with contact, note and hold options asks
     five questions to answer one — "More options" promotes the same draft into the full
     dialog for the times the rest is actually wanted. */
  const [quick, setQuick] = useState<{ readonly span: DraftSpan; readonly at: Anchor } | null>(
    null,
  );

  /* Built here rather than handed down: a server component cannot pass a function across the
     boundary, and the link only ever needs the calendar it is already given. */
  const dayHref = (iso: string): string =>
    `/appointments?calendar=${encodeURIComponent(calendarId)}&view=day&date=${iso}`;

  const openBooking = (booking: BookingView): void => {
    setQuick(null);
    setTarget({ kind: "existing", booking });
  };

  const openQuick = (span: DraftSpan, at: Anchor): void => setQuick({ span, at });

  /** A day with no gesture behind it: one normal-length appointment at the top of the day. */
  const addOn = (dayIso: string, at: Anchor): void =>
    openQuick(
      { dayIso, startMinute, endMinute: Math.min(startMinute + slotMinutes, endMinute) },
      at,
    );

  /* "Add appointment" needs a day, and in the month view the anchor day is the honest choice —
     the first day of the period on screen that is actually in it. */
  const firstDay =
    view === "month" ? (cells.flat().find((cell) => cell.inMonth)?.iso ?? null) : (days[0]?.iso ?? null);

  return (
    <div className="flex flex-col gap-3">
      {canWrite && firstDay !== null && (
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              addOn(firstDay, { x: box.left - 220, y: box.bottom });
            }}
          >
            <Plus aria-hidden className="size-3.5" />
            Add appointment
          </Button>
        </div>
      )}

      {view === "schedule" ? (
        <ScheduleList
          days={days}
          canWrite={canWrite}
          onOpenBooking={openBooking}
          onAddOn={addOn}
        />
      ) : view === "month" ? (
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
          onDraft={openQuick}
        />
      )}

      <QuickCreate
        calendarId={calendarId}
        span={quick?.span ?? null}
        anchor={quick?.at ?? null}
        timeZone={timeZone}
        onClose={() => setQuick(null)}
        onMoreOptions={(span) => {
          setQuick(null);
          setTarget({ kind: "new", span });
        }}
      />

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
