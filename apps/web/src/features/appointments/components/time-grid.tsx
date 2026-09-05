"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";

import { Tag } from "@/components/ui";
import { cn } from "@/lib/cn";

import { dragSpan, minuteAt, snapStepFor, type Span } from "../appointments.drag";
import { bookingLabel } from "../appointments.range";
import { clockLabel, minutesOfDay } from "../appointments.time";
import type { BookingView, DayColumn, DraftSpan } from "../appointments.view";

/** Pixels per hour. The grid's whole vertical scale derives from this one number. */
const HOUR_PX = 52;
const pxFor = (minutes: number): number => (minutes / 60) * HOUR_PX;

interface Drag {
  readonly dayIso: string;
  readonly anchorMinute: number;
  readonly pointerMinute: number;
}

/**
 * The time grid: one day or a whole week, on a shared clock.
 *
 * A day view is this with one column and a week view is this with seven, which is why there is
 * no second component for it — the placement, the drag, the now-line and the keyboard route
 * are identical, and a copy of them would be a copy of every future bug.
 *
 * **Empty time is bookable everywhere.** Press anywhere in a column and drag, and you get an
 * appointment of exactly that span; press without dragging and you get one of the calendar's
 * usual length starting there. This is the difference between a calendar and a booking form,
 * and it is why free slots are drawn *behind* as tinted ground rather than as the only thing
 * you may click: they say which times the calendar's weekly hours leave open — the times an
 * agent would offer on a call, once a tool exists to book one — and that is worth seeing
 * without being a limit on what the person at the desk may write down.
 *
 * That leaves the keyboard, which cannot drag. Every appointment is a real button in time
 * order, and each column header carries an add button that opens the same dialog on that day —
 * so nothing here is reachable only by mouse.
 */
export const TimeGrid = ({
  days,
  startMinute,
  endMinute,
  timeZone,
  slotMinutes,
  hasHours,
  canWrite,
  onOpenBooking,
  onDraft,
}: {
  readonly days: readonly DayColumn[];
  readonly startMinute: number;
  readonly endMinute: number;
  readonly timeZone: string;
  readonly slotMinutes: number;
  /** Whether the calendar has weekly hours at all — without them nothing is ever "full". */
  readonly hasHours: boolean;
  readonly canWrite: boolean;
  readonly onOpenBooking: (booking: BookingView) => void;
  readonly onDraft: (span: DraftSpan, at: { readonly x: number; readonly y: number }) => void;
}) => {
  const [drag, setDrag] = useState<Drag | null>(null);
  const columnTop = useRef(0);

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

  /* Escape abandons a drag in progress. Without it the only way out of a press that was a
     mistake is to complete it and then cancel the appointment it made. */
  useEffect(() => {
    if (drag === null) return;
    const abandon = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDrag(null);
    };
    window.addEventListener("keydown", abandon);
    return () => window.removeEventListener("keydown", abandon);
  }, [drag]);

  const step = snapStepFor(slotMinutes);
  const spanOf = (state: Drag): Span =>
    dragSpan({
      anchorMinute: state.anchorMinute,
      pointerMinute: state.pointerMinute,
      step,
      defaultMinutes: slotMinutes,
      dayStartMinute: startMinute,
      dayEndMinute: endMinute,
    });

  const gridHeight = pxFor(endMinute - startMinute);
  const hours: number[] = [];
  for (let minute = Math.ceil(startMinute / 60) * 60; minute <= endMinute; minute += 60) {
    hours.push(minute);
  }

  const columns = `56px repeat(${days.length}, minmax(0, 1fr))`;
  /* One column wants to fill the box; seven need a floor before they stop being readable. */
  const minWidth = days.length > 1 ? "min-w-[760px]" : "min-w-0";

  const beginDrag = (dayIso: string) => (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canWrite || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    columnTop.current = rect.top;
    const minute = minuteAt(event.clientY - rect.top, HOUR_PX, startMinute);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ dayIso, anchorMinute: minute, pointerMinute: minute });
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag === null) return;
    const minute = minuteAt(event.clientY - columnTop.current, HOUR_PX, startMinute);
    setDrag({ ...drag, pointerMinute: minute });
  };

  /* Released — including released outside the column, which pointer capture still delivers
     here, and which `dragSpan` folds back inside the day. */
  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag === null) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const span = spanOf(drag);
    setDrag(null);
    onDraft(
      { dayIso: drag.dayIso, startMinute: span.startMinute, endMinute: span.endMinute },
      { x: event.clientX, y: event.clientY },
    );
  };

  /** The keyboard's way in: a normal-length appointment at the top of the drawn day. */
  const addOn = (dayIso: string, at: { readonly x: number; readonly y: number }): void =>
    onDraft(
      { dayIso, startMinute, endMinute: Math.min(startMinute + slotMinutes, endMinute) },
      at,
    );

  return (
    <div className="surface overflow-auto rounded-xl">
      <div className={minWidth}>
        {/* Header: day names, sticky so they stay while the day scrolls under them. */}
        <div
          className="sticky top-0 z-10 grid border-b border-[var(--hairline)] bg-[var(--surface-solid)]"
          style={{ gridTemplateColumns: columns }}
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
              <div className="flex items-center gap-1">
                {/* "Full" means the agent has no time left to offer, which is only a
                    statement a calendar with hours can make. Without hours there are never
                    any slots, and calling every booked day full would be noise. */}
                {hasHours && day.slots.length === 0 && day.bookings.length > 0 && (
                  <Tag tone="warn">Full</Tag>
                )}
                {canWrite && (
                  <button
                    type="button"
                    onClick={(event) => {
                      const box = event.currentTarget.getBoundingClientRect();
                      addOn(day.iso, { x: box.left, y: box.bottom });
                    }}
                    aria-label={`Add an appointment on ${day.shortLabel} ${day.dayNumber}`}
                    className="rounded-md p-1 text-[var(--ink-3)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]"
                  >
                    <Plus aria-hidden className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Body: the time gutter plus the day columns, all the same height. */}
        <div className="grid" style={{ gridTemplateColumns: columns, height: `${gridHeight}px` }}>
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

          {days.map((day) => {
            const dragging = drag !== null && drag.dayIso === day.iso ? spanOf(drag) : null;
            return (
              <div
                key={day.iso}
                className={cn(
                  "relative border-l border-[var(--surface-line)]",
                  day.isToday && "bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]",
                  canWrite && "cursor-cell",
                )}
                onPointerDown={beginDrag(day.iso)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={() => setDrag(null)}
              >
                {/* Free slots: tinted ground saying which times the weekly hours leave open.
                    Not buttons — the whole column is bookable, and a button here would eat
                    the drag that starts on it. */}
                {day.slots.map((slot) => (
                  <div
                    key={slot.start}
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bg-[color-mix(in_srgb,var(--good)_7%,transparent)]"
                    style={{
                      top: `${pxFor(slot.startMinute - startMinute)}px`,
                      height: `${Math.max(pxFor(slot.endMinute - slot.startMinute), 2)}px`,
                    }}
                  />
                ))}

                {hours.map((minute) => (
                  <div
                    key={minute}
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 border-t border-[var(--surface-line)]"
                    style={{ top: `${pxFor(minute - startMinute)}px` }}
                  />
                ))}

                {day.isToday &&
                  nowMinute !== null &&
                  nowMinute >= startMinute &&
                  nowMinute <= endMinute && (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-[var(--bad)]"
                      style={{ top: `${pxFor(nowMinute - startMinute)}px` }}
                    >
                      <span className="absolute -top-1 -left-0.5 size-2 rounded-full bg-[var(--bad)]" />
                    </div>
                  )}

                {/* The span being drawn, so a drag is visible while it happens. */}
                {dragging !== null && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-1 z-[6] rounded-md border-2 border-dashed border-[var(--accent)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--accent)]"
                    style={{
                      top: `${pxFor(dragging.startMinute - startMinute)}px`,
                      height: `${Math.max(pxFor(dragging.endMinute - dragging.startMinute), 14)}px`,
                    }}
                  >
                    {clockLabel(dragging.startMinute)} – {clockLabel(dragging.endMinute)}
                  </div>
                )}

                {day.bookings.map((booking) => (
                  <button
                    key={booking.id}
                    type="button"
                    /* The press that opens an appointment must not also start a drag on the
                       empty column underneath it. */
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onOpenBooking(booking)}
                    className={cn(
                      "absolute inset-x-1 z-[5] cursor-pointer overflow-hidden rounded-md border px-1.5 py-1 text-left text-[11px] leading-tight",
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
                    <span className="block truncate">{bookingLabel(booking)}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
