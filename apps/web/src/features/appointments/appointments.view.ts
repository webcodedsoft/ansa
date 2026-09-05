/**
 * The shapes the calendar draws.
 *
 * One home for them, because four components and a page all pass the same appointment around
 * and each one owning its own copy is how two of them quietly drift apart. Plain data with no
 * JSX, so it lives beside the feature as `.ts` and the components render it.
 *
 * These are deliberately not the API's types. The grid needs a minute of the day to place a
 * block at, which the API has no reason to send — it sends instants, and where those land is
 * a question about the calendar's timezone that `appointments.time.ts` answers. Keeping the
 * placed shape separate is what stops that arithmetic leaking into a component.
 */

/** An appointment as the grid draws it: the API's row plus where it lands on the day. */
export interface BookingView {
  readonly id: string;
  readonly status: "held" | "booked";
  readonly startsAt: string;
  readonly endsAt: string;
  /** Minutes from midnight in the calendar's zone, clamped to the day this block is drawn on. */
  readonly startMinute: number;
  readonly endMinute: number;
  readonly contactId: string | null;
  readonly title: string | null;
  readonly notes: string | null;
  readonly holdExpiresAt: string | null;
  readonly source: string;
}

/** A free slot, already placed by minute. Drawn behind the appointments as bookable ground. */
export interface SlotView {
  readonly start: string;
  readonly end: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly label: string;
}

/** One column of the time grid: a day, its free slots, and what is already in it. */
export interface DayColumn {
  readonly iso: string;
  readonly weekday: number;
  readonly shortLabel: string;
  readonly dayNumber: number;
  readonly isToday: boolean;
  readonly slots: readonly SlotView[];
  readonly bookings: readonly BookingView[];
}

/** One cell of the month grid. `inMonth` is false for the days borrowed either side. */
export interface MonthCell {
  readonly iso: string;
  readonly dayNumber: number;
  readonly shortLabel: string;
  readonly inMonth: boolean;
  readonly isToday: boolean;
  readonly bookings: readonly BookingView[];
}

/**
 * A span of time the operator has asked to fill, before it is an appointment.
 *
 * What a drag on an empty part of the grid produces, and what the dialog opens on. The day is
 * an ISO date rather than an instant because the minutes are wall-clock minutes in the
 * calendar's zone; resolving the two into an instant is the dialog's last act before saving.
 */
export interface DraftSpan {
  readonly dayIso: string;
  readonly startMinute: number;
  readonly endMinute: number;
}
