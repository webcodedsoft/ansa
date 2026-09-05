"use client";

import { useEffect, useState } from "react";

import { Tag } from "@/components/ui";
import { cn } from "@/lib/cn";

import { clockLabel, minutesOfDay } from "../appointments.time";
import { BookingDetails, type BookingView } from "./booking-details";
import { BookingDialog, type SlotChoice } from "./booking-dialog";

export interface PlacedSlotView {
  readonly start: string;
  readonly end: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly label: string;
}

export interface DayColumn {
  readonly iso: string;
  readonly weekday: number;
  readonly shortLabel: string;
  readonly dayNumber: number;
  readonly isToday: boolean;
  readonly slots: readonly PlacedSlotView[];
  readonly bookings: readonly BookingView[];
}

/** Pixels per hour. The grid's whole vertical scale derives from this one number. */
const HOUR_PX = 52;
const pxFor = (minutes: number): number => (minutes / 60) * HOUR_PX;

/**
 * The week, as a real calendar.
 *
 * A time-grid rather than a list: seven day columns over a shared time axis, drawn in the
 * calendar's own timezone, with free slots and existing bookings placed by the minute. The
 * whole thing scrolls inside its own box on both axes — vertically through the day, and
 * horizontally on a narrow screen — so a long day or a small phone never widens the page body
 * and drags the sidebar with it.
 *
 * Free slots are buttons; a held or booked appointment is a block that opens its own details.
 * Everything interactive is a real `<button>` in time order, so the grid is walkable by Tab
 * and operable by Enter without a mouse. Booking, holding, confirming and cancelling all live
 * in the two dialogs this owns.
 */
export const WeekGrid = ({
  calendarId,
  days,
  startMinute,
  endMinute,
  timeZone,
  canWrite,
}: {
  readonly calendarId: string;
  readonly days: readonly DayColumn[];
  readonly startMinute: number;
  readonly endMinute: number;
  readonly timeZone: string;
  readonly canWrite: boolean;
}) => {
  const [openSlot, setOpenSlot] = useState<SlotChoice | null>(null);
  const [openBooking, setOpenBooking] = useState<BookingView | null>(null);

  /* The now-line is set after mount, never during render: the server and the browser render
     at different instants, and drawing it during render would be a guaranteed hydration
     mismatch. Refreshed each minute so it does not drift over a long session. */
  const [nowMinute, setNowMinute] = useState<number | null>(null);
  useEffect(() => {
    const tick = (): void => setNowMinute(minutesOfDay(new Date(), timeZone));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [timeZone]);

  const gridHeight = pxFor(endMinute - startMinute);
  const hours: number[] = [];
  for (let minute = Math.ceil(startMinute / 60) * 60; minute <= endMinute; minute += 60) {
    hours.push(minute);
  }

  return (
    <>
      <div className="surface overflow-auto rounded-xl">
        {/* min-width keeps the columns usable; the box scrolls rather than the page. */}
        <div className="min-w-[760px]">
          {/* Header: day names, sticky so they stay while the day scrolls under them. */}
          <div
            className="sticky top-0 z-10 grid border-b border-[var(--hairline)] bg-[var(--surface-solid)]"
            style={{ gridTemplateColumns: `56px repeat(7, minmax(0, 1fr))` }}
          >
            <div className="px-2 py-2" />
            {days.map((day) => (
              <div
                key={day.iso}
                className={cn(
                  "flex items-center justify-between gap-1 border-l border-[var(--surface-line)] px-2.5 py-2",
                  day.isToday && "bg-[var(--accent-soft)]",
                )}
              >
                <div>
                  <div className="text-[11px] font-medium tracking-wide text-[var(--ink-3)] uppercase">
                    {day.shortLabel}
                  </div>
                  <div
                    className={cn(
                      "text-[15px] font-semibold tabular-nums",
                      day.isToday && "text-[var(--accent)]",
                    )}
                  >
                    {day.dayNumber}
                  </div>
                </div>
                {day.slots.length === 0 && day.bookings.length > 0 && (
                  <Tag tone="warn">Full</Tag>
                )}
              </div>
            ))}
          </div>

          {/* Body: the time gutter plus seven day columns, all the same height. */}
          <div
            className="grid"
            style={{ gridTemplateColumns: `56px repeat(7, minmax(0, 1fr))`, height: `${gridHeight}px` }}
          >
            {/* Time gutter. */}
            <div className="relative">
              {hours.map((minute) => (
                <div
                  key={minute}
                  className="absolute right-2 -translate-y-1/2 text-[10.5px] tabular-nums text-[var(--ink-3)]"
                  style={{ top: `${pxFor(minute - startMinute)}px` }}
                >
                  {clockLabel(minute)}
                </div>
              ))}
            </div>

            {days.map((day) => (
              <div
                key={day.iso}
                className={cn(
                  "relative border-l border-[var(--surface-line)]",
                  day.isToday && "bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]",
                )}
              >
                {/* Hour lines. */}
                {hours.map((minute) => (
                  <div
                    key={minute}
                    aria-hidden
                    className="absolute inset-x-0 border-t border-[var(--surface-line)]"
                    style={{ top: `${pxFor(minute - startMinute)}px` }}
                  />
                ))}

                {/* The now-line, on today only. */}
                {day.isToday &&
                  nowMinute !== null &&
                  nowMinute >= startMinute &&
                  nowMinute <= endMinute && (
                    <div
                      aria-hidden
                      className="absolute inset-x-0 z-20 border-t-2 border-[var(--bad)]"
                      style={{ top: `${pxFor(nowMinute - startMinute)}px` }}
                    >
                      <span className="absolute -top-1 -left-0.5 size-2 rounded-full bg-[var(--bad)]" />
                    </div>
                  )}

                {/* Bookings first, then free slots — the two never share minutes, since a booked
                    time is not offered as free. */}
                {day.bookings.map((booking) => (
                  <button
                    key={booking.id}
                    type="button"
                    onClick={() => setOpenBooking(booking)}
                    className={cn(
                      "absolute inset-x-1 z-[5] overflow-hidden rounded-md border px-1.5 py-1 text-left text-[11px] leading-tight",
                      booking.status === "held"
                        ? "border-dashed border-[color-mix(in_srgb,var(--warn)_55%,transparent)] bg-[var(--warn-soft)] text-[var(--warn)]"
                        : "border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[var(--accent-soft)] text-[var(--accent)]",
                    )}
                    style={{
                      top: `${pxFor(booking.startMinute - startMinute)}px`,
                      height: `${Math.max(pxFor(booking.endMinute - booking.startMinute) - 2, 14)}px`,
                    }}
                  >
                    <span className="block font-medium">{clockLabel(booking.startMinute)}</span>
                    <span className="block truncate">
                      {booking.status === "held" ? "Held" : "Booked"}
                    </span>
                  </button>
                ))}

                {day.slots.map((slot) => {
                  const height = Math.max(pxFor(slot.endMinute - slot.startMinute) - 2, 14);
                  return (
                    <button
                      key={slot.start}
                      type="button"
                      disabled={!canWrite}
                      aria-label={`Book ${slot.label} on ${day.shortLabel} ${day.dayNumber}`}
                      onClick={() => setOpenSlot({ start: slot.start, end: slot.end })}
                      className={cn(
                        "absolute inset-x-1 overflow-hidden rounded-md border border-[var(--hairline)] bg-[var(--surface-2)] px-1.5 py-0.5 text-left text-[11px] leading-tight text-[var(--ink-2)]",
                        "transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]",
                        "disabled:cursor-default disabled:opacity-70 disabled:hover:border-[var(--hairline)] disabled:hover:bg-[var(--surface-2)] disabled:hover:text-[var(--ink-2)]",
                      )}
                      style={{
                        top: `${pxFor(slot.startMinute - startMinute)}px`,
                        height: `${height}px`,
                      }}
                    >
                      {slot.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <BookingDialog
        calendarId={calendarId}
        slot={openSlot}
        timeZone={timeZone}
        onClose={() => setOpenSlot(null)}
      />
      <BookingDetails
        booking={openBooking}
        timeZone={timeZone}
        canWrite={canWrite}
        onClose={() => setOpenBooking(null)}
      />
    </>
  );
};
