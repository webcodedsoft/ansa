import {
  expireLapsedHolds,
  readAvailability,
  readBookings,
  readCalendar,
  readHolidays,
  type AppointmentCalendar,
  type OrganizationScope,
} from "@ansa/db";

import { computeFreeSlots, localDateKey, type Slot } from "./slots";

/** A day, plus the buffer: enough to catch an appointment that ends just before a range. */
const bookingLookback = (bufferMinutes: number): number =>
  24 * 60 * 60_000 + bufferMinutes * 60_000;

/**
 * What a diary has free in `[from, to)` — the whole assembly, in one place.
 *
 * This exists as a function rather than as the body of the slots endpoint because there are
 * now two callers that must agree: the console asking "draw me the free hours", and a caller
 * on the phone asking "when can you see me". The three subtleties below were each found once,
 * in one of the two copies, and a second copy is a second chance to fix only one of them.
 *
 * The lookback: `readBookings` keeps a row only while `ends_at > from`, so an appointment
 * that finishes just before the range is never loaded — and `computeFreeSlots` cannot apply
 * a buffer to a booking it was not given. With a 30-minute buffer and an appointment ending
 * at 09:00, asking from 09:00 offered 09:00 itself, inside the dead time beside it.
 *
 * The zone: the days a range covers in the *calendar's* zone are not always the days it
 * covers in UTC. Half past eleven at night in Lagos is already tomorrow in Kiritimati. Ask
 * for holidays in the calendar's zone or the holiday lands on the wrong day.
 *
 * The lapsed holds: released first, so a slot a dropped call never let go of is offered
 * again rather than held against a caller who is on the phone now.
 *
 * Null means no such calendar in this organisation — which reads the same as one that does
 * not exist, deliberately, and is the caller's to turn into a 404 or into speech.
 */
export const freeSlotsIn = async (
  scope: OrganizationScope,
  calendarId: string,
  range: { readonly from: Date; readonly to: Date },
): Promise<{ readonly calendar: AppointmentCalendar; readonly slots: readonly Slot[] } | null> => {
  const calendar = await readCalendar(scope, calendarId);
  if (calendar === null) return null;

  const windows = await readAvailability(scope, calendarId);
  await expireLapsedHolds(scope, calendarId, new Date());

  const guard = bookingLookback(calendar.bufferMinutes);
  const bookings = await readBookings(scope, calendarId, {
    from: new Date(range.from.getTime() - guard),
    to: new Date(range.to.getTime() + calendar.bufferMinutes * 60_000),
  });
  const shut = await readHolidays(scope, {
    from: localDateKey(range.from, calendar.timezone),
    to: localDateKey(range.to, calendar.timezone),
  });

  return {
    calendar,
    slots: computeFreeSlots({
      timeZone: calendar.timezone,
      slotMinutes: calendar.slotMinutes,
      bufferMinutes: calendar.bufferMinutes,
      windows,
      bookings,
      holidays: shut.map((day) => day.onDate),
      from: range.from,
      to: range.to,
    }),
  };
};
