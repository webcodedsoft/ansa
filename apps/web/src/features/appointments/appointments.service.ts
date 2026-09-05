import { api } from "@/lib/api/server";

import type {
  AvailabilityWeekInput,
  CreateBookingInput,
  CreateCalendarInput,
  EditCalendarInput,
} from "./appointments.schema";

/**
 * Everything this app does with calendars, hours, slots and bookings.
 *
 * The one place the appointments feature talks to the API. Pages read through it and actions
 * write through it; nothing outside this file constructs a client for appointments, which is
 * what keeps an endpoint rename a one-file change.
 *
 * The read helpers return the API's own shapes unchanged — the slots already carry the
 * calendar's UTC offset and the bookings carry ISO instants, so there is nothing here to
 * reshape and no timezone to invent. The placement into a week grid is pure arithmetic and
 * lives in `appointments.time.ts`.
 */

export const listCalendars = async () => (await api()).appointments.listCalendars();

export const readCalendar = async (calendarId: string) =>
  (await api()).appointments.readCalendar({ path: { calendarId } });

export const createCalendar = async (input: CreateCalendarInput) =>
  (await api()).appointments.createCalendar({
    body: {
      name: input.name,
      timezone: input.timezone,
      slotMinutes: input.slotMinutes,
      bufferMinutes: input.bufferMinutes,
      source: input.source,
      ...(input.source === "connector" && input.externalRef !== undefined
        ? { externalRef: input.externalRef }
        : {}),
    },
  });

export const editCalendar = async (calendarId: string, input: EditCalendarInput) =>
  (await api()).appointments.editCalendar({
    path: { calendarId },
    body: {
      name: input.name,
      timezone: input.timezone,
      slotMinutes: input.slotMinutes,
      bufferMinutes: input.bufferMinutes,
    },
  });

export const readAvailability = async (calendarId: string) =>
  (await api()).appointments.readAvailability({ path: { calendarId } });

export const replaceAvailability = async (calendarId: string, input: AvailabilityWeekInput) =>
  (await api()).appointments.replaceAvailability({
    path: { calendarId },
    body: { windows: input.windows },
  });

export const listSlots = async (calendarId: string, from: string, to: string) =>
  (await api()).appointments.slots({ path: { calendarId }, query: { from, to } });

export const listBookings = async (calendarId: string, from: string, to: string) =>
  (await api()).appointments.listBookings({ path: { calendarId }, query: { from, to } });

export const createBooking = async (calendarId: string, input: CreateBookingInput) =>
  (await api()).appointments.createBooking({
    path: { calendarId },
    body: {
      startsAt: input.startsAt,
      source: "manual",
      status: input.status,
      ...(input.status === "held" && input.holdMinutes !== undefined
        ? { holdMinutes: input.holdMinutes }
        : {}),
      ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
      ...(input.notes !== undefined && input.notes !== "" ? { notes: input.notes } : {}),
    },
  });

export const confirmBooking = async (bookingId: string) =>
  (await api()).appointments.confirmBooking({ path: { bookingId } });

export const cancelBooking = async (bookingId: string) =>
  (await api()).appointments.cancelBooking({ path: { bookingId } });

export type CalendarSummary = Awaited<ReturnType<typeof listCalendars>>["items"][number];
export type Calendar = Awaited<ReturnType<typeof readCalendar>>;
export type AvailabilityWindows = Awaited<ReturnType<typeof readAvailability>>["windows"];
export type FreeSlot = Awaited<ReturnType<typeof listSlots>>["slots"][number];
export type Booking = Awaited<ReturnType<typeof listBookings>>["items"][number];
