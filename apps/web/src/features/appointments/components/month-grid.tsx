"use client";

import Link from "next/link";

import { cn } from "@/lib/cn";

import { bookingLabel } from "../appointments.range";
import { clockLabel } from "../appointments.time";
import type { BookingView, MonthCell } from "../appointments.view";

/** How many appointments a cell shows before it stops and counts the rest. */
const VISIBLE_PER_DAY = 3;

/**
 * How many columns the grid has, read off the data rather than assumed.
 *
 * A month is seven columns until weekends are hidden, when it is five. Hard-coding seven and
 * then feeding it five-day rows does not draw a narrower grid — it wraps the cells every
 * seventh one and silently shifts every date into the wrong weekday.
 */
const columns = (weeks: readonly (readonly MonthCell[])[]): string =>
  `repeat(${weeks[0]?.length ?? 7}, minmax(0, 1fr))`;

/**
 * The month: six weeks of cells, each listing what is in that day.
 *
 * A month is not a time grid at a smaller scale — placing a 30-minute appointment by the pixel
 * inside a cell an inch tall produces slivers nobody can read or hit. So this is a list per
 * day, in time order, which is what a month view is for: seeing where the week is heavy, not
 * reading a clock.
 *
 * Cells are always six rows, borrowed from the months either side and dimmed, so paging
 * through the year does not make the page jump in height. A cell's empty space adds an
 * appointment on that day; a cell with more than it can show links into its own day view
 * rather than growing, because a growing cell is what makes the other five rows unreadable.
 */
export const MonthGrid = ({
  weeks,
  canWrite,
  dayHref,
  onOpenBooking,
  onAddOn,
}: {
  readonly weeks: readonly (readonly MonthCell[])[];
  readonly canWrite: boolean;
  readonly dayHref: (iso: string) => string;
  readonly onOpenBooking: (booking: BookingView) => void;
  readonly onAddOn: (dayIso: string, at: { readonly x: number; readonly y: number }) => void;
}) => (
  <div className="surface overflow-hidden rounded-xl">
    <div
      className="grid border-b border-[var(--hairline)] bg-[var(--surface-solid)]"
      style={{ gridTemplateColumns: columns(weeks) }}
    >
      {(weeks[0] ?? []).map((cell) => (
        <div
          key={cell.iso}
          className="border-l border-[var(--surface-line)] px-2 py-1.5 text-[11px] font-medium tracking-wide text-[var(--ink-3)] uppercase first:border-l-0"
        >
          {cell.shortLabel}
        </div>
      ))}
    </div>

    <div className="grid" style={{ gridTemplateColumns: columns(weeks) }}>
      {weeks.flat().map((cell) => {
        const shown = cell.bookings.slice(0, VISIBLE_PER_DAY);
        const hidden = cell.bookings.length - shown.length;
        return (
          <div
            key={cell.iso}
            className={cn(
              "relative flex min-h-[104px] flex-col gap-0.5 border-t border-l border-[var(--surface-line)] p-1.5",
              !cell.inMonth && "bg-[var(--surface-2)]",
            )}
          >
            <div className="flex items-center justify-between">
              <span
                className={cn(
                  "text-[12px] font-semibold tabular-nums",
                  !cell.inMonth && "text-[var(--ink-3)]",
                  cell.isToday &&
                    "flex size-5 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--on-accent)]",
                )}
              >
                {cell.dayNumber}
              </span>
            </div>

            {/* The empty part of the cell adds an appointment to that day. A button rather
                than a click handler on the cell, so it is reachable by Tab like everything
                else — and it sits behind the appointments, which are buttons of their own. */}
            {canWrite && (
              <button
                type="button"
                onClick={(event) => onAddOn(cell.iso, { x: event.clientX, y: event.clientY })}
                aria-label={`Add an appointment on ${cell.iso}`}
                className="absolute inset-0 cursor-cell rounded-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset"
              />
            )}

            <div className="relative flex flex-col gap-0.5">
              {shown.map((booking) => (
                <button
                  key={booking.id}
                  type="button"
                  onClick={() => onOpenBooking(booking)}
                  title={bookingLabel(booking)}
                  className={cn(
                    "flex w-full items-baseline gap-1 overflow-hidden rounded px-1 py-0.5 text-left text-[11px] leading-tight",
                    booking.status === "held"
                      ? "bg-[var(--warn-soft)] text-[var(--warn)]"
                      : "bg-[var(--accent-soft)] text-[var(--accent)]",
                  )}
                >
                  <span className="shrink-0 tabular-nums opacity-80">
                    {clockLabel(booking.startMinute)}
                  </span>
                  <span className="truncate">{bookingLabel(booking)}</span>
                </button>
              ))}

              {hidden > 0 && (
                <Link
                  href={dayHref(cell.iso)}
                  className="rounded px-1 text-[11px] font-medium text-[var(--ink-3)] hover:text-[var(--accent)]"
                >
                  +{hidden} more
                </Link>
              )}
            </div>
          </div>
        );
      })}
    </div>
  </div>
);
