"use client";

import { cn } from "@/lib/cn";

import { bookingLabel } from "../appointments.range";
import { clockLabel } from "../appointments.time";
import type { BookingView, DayColumn } from "../appointments.view";

/**
 * What is coming up, as a list.
 *
 * The question a front desk actually asks is "what is next", and no grid answers it — a week
 * view makes you read seven columns and do the arithmetic yourself, and on a phone it makes
 * you read them sideways. So this is the one view with no clock on it: days in order, each
 * with what is in it, and days with nothing in them left out entirely.
 *
 * Empty days are omitted rather than listed as empty because an agenda of thirty rows, of
 * which twenty-six say "nothing", is a worse answer than four rows. The heading says which
 * span is being listed, so a completely empty stretch still reads as deliberate.
 */
export const ScheduleList = ({
  days,
  canWrite,
  onOpenBooking,
  onAddOn,
}: {
  readonly days: readonly DayColumn[];
  readonly canWrite: boolean;
  readonly onOpenBooking: (booking: BookingView) => void;
  readonly onAddOn: (dayIso: string) => void;
}) => {
  const busy = days.filter((day) => day.bookings.length > 0);

  if (busy.length === 0) {
    return (
      <div className="surface rounded-xl px-4 py-10 text-center">
        <p className="text-[13.5px] font-medium">Nothing booked in this stretch.</p>
        <p className="mt-1 text-[12.5px] text-[var(--ink-3)]">
          Appointments taken on a call appear here too, as soon as they are made.
        </p>
      </div>
    );
  }

  return (
    <div className="surface divide-y divide-[var(--surface-line)] overflow-hidden rounded-xl">
      {busy.map((day) => (
        <div key={day.iso} className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 px-3.5 py-3">
          <div className={cn("pt-0.5", day.isToday && "text-[var(--accent)]")}>
            <div className="text-[11px] font-medium tracking-wide uppercase opacity-70">
              {day.shortLabel}
            </div>
            <div className="text-[17px] font-semibold tabular-nums">{day.dayNumber}</div>
            {day.isToday && <div className="text-[10.5px] font-medium">Today</div>}
          </div>

          <div className="flex flex-col gap-1">
            {day.bookings.map((booking) => (
              <button
                key={booking.id}
                type="button"
                onClick={() => onOpenBooking(booking)}
                className="flex items-baseline gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-2)]"
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-1.5 size-1.5 shrink-0 rounded-full",
                    booking.status === "held" ? "bg-[var(--warn)]" : "bg-[var(--accent)]",
                  )}
                />
                <span className="w-[104px] shrink-0 text-[12.5px] tabular-nums text-[var(--ink-3)]">
                  {clockLabel(booking.startMinute)} – {clockLabel(booking.endMinute)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13.5px]">
                  {bookingLabel(booking)}
                </span>
                {booking.status === "held" && (
                  <span className="shrink-0 text-[11px] font-medium text-[var(--warn)]">Held</span>
                )}
              </button>
            ))}

            {canWrite && (
              <button
                type="button"
                onClick={() => onAddOn(day.iso)}
                className="self-start rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--ink-3)] transition-colors hover:text-[var(--accent)]"
              >
                + Add on this day
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
