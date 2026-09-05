import { z } from "zod";

/**
 * What this app is allowed to submit about calendars, hours and bookings.
 *
 * As everywhere else in the console, this is not a second copy of the API's rules. The API
 * owns tenancy, the IANA-zone check, the overlap check and the 409 when a slot is taken; this
 * catches the two or three shapes worth catching before a round trip and gives the API's own
 * refusal a field to land on when it says no anyway.
 */

const calendarName = z
  .string()
  .trim()
  .min(1, "Give the calendar a name.")
  .max(120, "That name is too long.");

/** A non-empty string; the API is the authority on whether it is a real IANA zone. */
const timezone = z.string().trim().min(1, "Choose a timezone.");

const slotMinutes = z
  .number({ error: "Slot length must be a number of minutes." })
  .int("Slot length must be whole minutes.")
  .min(5, "A slot must be at least 5 minutes.")
  .max(24 * 60, "A slot cannot be longer than a day.");

const bufferMinutes = z
  .number({ error: "Buffer must be a number of minutes." })
  .int("Buffer must be whole minutes.")
  .min(0, "Buffer cannot be negative.")
  .max(24 * 60, "That buffer is longer than a day.");

/**
 * Creating a calendar.
 *
 * A `connector` calendar mirrors an outside diary and is meaningless without the reference
 * that names it there, so `externalRef` is required exactly when the source is `connector` and
 * refused otherwise — the same rule the API holds, checked here so the message lands on the
 * field rather than arriving as a body error.
 */
export const createCalendarSchema = z
  .object({
    name: calendarName,
    timezone,
    slotMinutes,
    bufferMinutes,
    source: z.enum(["hosted", "connector"]),
    externalRef: z.string().trim().max(200, "That reference is too long.").optional(),
  })
  .superRefine((value, ctx) => {
    if (value.source === "connector" && (value.externalRef === undefined || value.externalRef === "")) {
      ctx.addIssue({
        code: "custom",
        path: ["externalRef"],
        message: "A connector calendar needs the reference it has in the outside diary.",
      });
    }
  });
export type CreateCalendarInput = z.infer<typeof createCalendarSchema>;

/** Editing a calendar. Source and externalRef are fixed once set, so they are not here. */
export const editCalendarSchema = z.object({
  name: calendarName,
  timezone,
  slotMinutes,
  bufferMinutes,
});
export type EditCalendarInput = z.infer<typeof editCalendarSchema>;

const availabilityWindow = z.object({
  weekday: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(24 * 60),
  endMinute: z.number().int().min(0).max(24 * 60),
});

/**
 * The whole week at once, the way the API takes it and the way it is edited.
 *
 * `end after start` and `no overlap on a weekday` are checked in `appointments.time.ts` before
 * this runs, so the schema only guards the shape; the human-readable rule violations are
 * reported from there against the named day.
 */
export const availabilityWeekSchema = z.object({
  windows: z.array(availabilityWindow),
});
export type AvailabilityWeekInput = z.infer<typeof availabilityWeekSchema>;

/**
 * Booking or holding a free slot.
 *
 * `startsAt` is the slot's own start, carried back verbatim from the slots endpoint, so it is
 * only checked for being a non-empty ISO string rather than re-derived. A held slot needs the
 * minutes it is held for; a booked one takes the chair outright.
 */
export const createBookingSchema = z.object({
  startsAt: z.string().min(1, "This booking has no start time."),
  status: z.enum(["held", "booked"]),
  holdMinutes: z.number().int().min(1).max(24 * 60).optional(),
  contactId: z.uuid().optional(),
  notes: z.string().trim().max(2000, "That note is too long.").optional(),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;
