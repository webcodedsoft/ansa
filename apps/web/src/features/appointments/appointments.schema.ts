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
 * Writing an appointment into the diary.
 *
 * `startsAt` and `endsAt` are ISO instants the grid computed from the calendar's own clock,
 * so they are checked for being present rather than re-derived — the browser's zone must not
 * get a vote, and the dialog already resolved the wall time through `zonedTimeToUtc`.
 *
 * `endsAt` is optional because a booking taken from a free slot is exactly one slot long and
 * the API supplies that length; a person dragging out a span sends both. When both are here
 * the order is checked, so a backwards span is refused against the End field rather than
 * coming back as a body error the form has nowhere to put.
 *
 * A held appointment needs the minutes it is held for; a booked one takes the chair outright.
 */
const isoInstant = z.string().min(1, "This appointment has no start time.");

const appointmentTitle = z
  .string()
  .trim()
  .max(200, "That title is too long.")
  .optional();

export const createBookingSchema = z
  .object({
    startsAt: isoInstant,
    endsAt: z.string().min(1).optional(),
    title: appointmentTitle,
    status: z.enum(["held", "booked"]),
    holdMinutes: z.number().int().min(1).max(24 * 60).optional(),
    contactId: z.uuid().optional(),
    notes: z.string().trim().max(2000, "That note is too long.").optional(),
  })
  .superRefine((value, ctx) => {
    if (value.endsAt !== undefined && Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "An appointment has to end after it starts.",
      });
    }
  });
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

/**
 * Moving, resizing or renaming an appointment already in the diary.
 *
 * The dialog edits a whole appointment rather than one field of it, so every field is sent
 * every time and an empty box means "clear this" — `null` rather than absent. That is the one
 * place this differs from the API, which distinguishes the two so a caller can touch a single
 * field; a form has no way to express the difference and pretending otherwise would make an
 * emptied note silently keep its old text.
 *
 * Times still travel together, as the API insists, because a start moved without its end is a
 * length nobody chose.
 */
export const editBookingSchema = z
  .object({
    startsAt: isoInstant,
    endsAt: z.string().min(1, "This appointment has no end time."),
    title: z.string().trim().max(200, "That title is too long.").nullable(),
    notes: z.string().trim().max(2000, "That note is too long.").nullable(),
    contactId: z.uuid().nullable(),
  })
  .superRefine((value, ctx) => {
    if (Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "An appointment has to end after it starts.",
      });
    }
  });
export type EditBookingInput = z.infer<typeof editBookingSchema>;
