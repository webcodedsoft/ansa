"use server";

import { revalidatePath } from "next/cache";

import { failureMessage, refusedWith } from "@/lib/api/server";
import { failedForm, invalidForm, succeededForm, type FormState } from "@/lib/form-state";

import { nameOf } from "@/features/contacts/contacts.display";
import { listContacts } from "@/features/contacts/contacts.service";

import {
  availabilityWeekSchema,
  createBookingSchema,
  editBookingSchema,
  createCalendarSchema,
  editCalendarSchema,
} from "./appointments.schema";
import {
  cancelBooking,
  confirmBooking,
  createBooking,
  createCalendar,
  editBooking,
  editCalendar,
  replaceAvailability,
} from "./appointments.service";
import { availabilityProblem, type AvailabilityWindow } from "./appointments.time";

/**
 * Server Actions for the appointments workspace.
 *
 * Each parses with its schema, calls the service, and revalidates `/appointments` so the week
 * grid, the calendar list and the hours editor all reflect the write on the next render —
 * they are one page reading one set of endpoints. The two writes a race can lose — booking a
 * slot and confirming a hold — revalidate even when they fail, because the reason they failed
 * is that the world moved, and the screen has to move with it or it offers the taken slot
 * again.
 */

const numberOrNaN = (raw: FormDataEntryValue | null): number =>
  raw === null || raw === "" ? Number.NaN : Number(raw);

const stringOrUndefined = (raw: FormDataEntryValue | null): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
};

/** An empty box means "clear this", which the API spells `null`. */
const stringOrNull = (raw: FormDataEntryValue | null): string | null => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
};

export interface CalendarSaved {
  readonly calendarId: string;
}

export type CalendarState = FormState<CalendarSaved>;

export const createCalendarAction = async (
  _previous: CalendarState,
  form: FormData,
): Promise<CalendarState> => {
  const parsed = createCalendarSchema.safeParse({
    name: form.get("name") ?? "",
    timezone: form.get("timezone") ?? "",
    slotMinutes: numberOrNaN(form.get("slotMinutes")),
    bufferMinutes: numberOrNaN(form.get("bufferMinutes")),
    source: form.get("source") ?? "hosted",
    externalRef: stringOrUndefined(form.get("externalRef")),
  });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const created = await createCalendar(parsed.data);
    revalidatePath("/appointments");
    return succeededForm({ calendarId: created.id }, `Created ${created.name}.`);
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

export const editCalendarAction = async (
  _previous: CalendarState,
  form: FormData,
): Promise<CalendarState> => {
  const calendarId = String(form.get("calendarId") ?? "");
  if (calendarId === "") return failedForm("This form does not say which calendar it is for.");

  const parsed = editCalendarSchema.safeParse({
    name: form.get("name") ?? "",
    timezone: form.get("timezone") ?? "",
    slotMinutes: numberOrNaN(form.get("slotMinutes")),
    bufferMinutes: numberOrNaN(form.get("bufferMinutes")),
  });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const saved = await editCalendar(calendarId, parsed.data);
    revalidatePath("/appointments");
    return succeededForm({ calendarId: saved.id }, `Saved ${saved.name}.`);
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

export type AvailabilityState = FormState<{ readonly windowCount: number }>;

/**
 * Replace a calendar's whole week of hours.
 *
 * The overlap and end-after-start checks run here before the send, mirroring the API, so the
 * operator is told which weekday is wrong rather than being handed a body error. The windows
 * arrive as one JSON field the editor built, because a variable number of rows across seven
 * days does not map onto flat form fields worth naming.
 */
export const replaceAvailabilityAction = async (
  _previous: AvailabilityState,
  form: FormData,
): Promise<AvailabilityState> => {
  const calendarId = String(form.get("calendarId") ?? "");
  if (calendarId === "") return failedForm("This form does not say which calendar it is for.");

  let windows: AvailabilityWindow[];
  try {
    windows = JSON.parse(String(form.get("windows") ?? "[]")) as AvailabilityWindow[];
  } catch {
    return failedForm("The hours could not be read. Reload the page and try again.");
  }

  const parsed = availabilityWeekSchema.safeParse({ windows });
  if (!parsed.success) return invalidForm(parsed.error);

  const problem = availabilityProblem(parsed.data.windows);
  if (problem !== null) return failedForm(problem);

  try {
    const saved = await replaceAvailability(calendarId, parsed.data);
    revalidatePath("/appointments");
    return succeededForm(
      { windowCount: saved.windows.length },
      saved.windows.length === 0
        ? "Hours cleared. This calendar now offers no slots."
        : `Saved ${saved.windows.length} open period${saved.windows.length === 1 ? "" : "s"}.`,
    );
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

export type BookingState = FormState<{ readonly bookingId: string; readonly status: string }>;

export const createBookingAction = async (
  _previous: BookingState,
  form: FormData,
): Promise<BookingState> => {
  const calendarId = String(form.get("calendarId") ?? "");
  if (calendarId === "") return failedForm("This form does not say which calendar it is for.");

  const status = String(form.get("status") ?? "booked");
  const holdRaw = form.get("holdMinutes");
  const parsed = createBookingSchema.safeParse({
    startsAt: form.get("startsAt") ?? "",
    endsAt: stringOrUndefined(form.get("endsAt")),
    title: stringOrUndefined(form.get("title")),
    status,
    ...(status === "held" ? { holdMinutes: numberOrNaN(holdRaw) } : {}),
    contactId: stringOrUndefined(form.get("contactId")),
    notes: stringOrUndefined(form.get("notes")),
  });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const booking = await createBooking(calendarId, parsed.data);
    revalidatePath("/appointments");
    return succeededForm(
      { bookingId: booking.id, status: booking.status },
      booking.status === "held" ? "Slot held." : "Slot booked.",
    );
  } catch (error) {
    /* A 409 means the slot was taken between being offered and being booked. Refresh anyway
       so the taken slot leaves the grid, then say so plainly rather than as a raw conflict. */
    if (refusedWith(error, 409)) {
      revalidatePath("/appointments");
      return failedForm("That slot was just taken. It has been removed from the grid — pick another.");
    }
    return failedForm(failureMessage(error));
  }
};

/**
 * Move, resize, rename or re-attach an appointment.
 *
 * What dragging a block on the grid comes down to, and what the details dialog saves. The two
 * refusals worth naming are named: a 409 means some other live appointment already starts at
 * that minute, and a 404 means the appointment moved out from under this dialog — cancelled
 * in another tab, most likely. Both revalidate before answering, because in both cases the
 * grid on screen is describing a world that has moved on.
 */
export const editBookingAction = async (
  _previous: BookingState,
  form: FormData,
): Promise<BookingState> => {
  const bookingId = String(form.get("bookingId") ?? "");
  if (bookingId === "") return failedForm("This form does not say which appointment it is for.");

  const parsed = editBookingSchema.safeParse({
    startsAt: form.get("startsAt") ?? "",
    endsAt: form.get("endsAt") ?? "",
    title: stringOrNull(form.get("title")),
    notes: stringOrNull(form.get("notes")),
    contactId: stringOrNull(form.get("contactId")),
  });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const booking = await editBooking(bookingId, parsed.data);
    revalidatePath("/appointments");
    return succeededForm({ bookingId: booking.id, status: booking.status }, "Appointment saved.");
  } catch (error) {
    if (refusedWith(error, 409)) {
      revalidatePath("/appointments");
      return failedForm(
        "Something else already starts at that time. Pick another time, or move that one first.",
      );
    }
    if (refusedWith(error, 404)) {
      revalidatePath("/appointments");
      return failedForm("That appointment is no longer there — it may have been cancelled.");
    }
    return failedForm(failureMessage(error));
  }
};

export const confirmBookingAction = async (
  _previous: BookingState,
  form: FormData,
): Promise<BookingState> => {
  const bookingId = String(form.get("bookingId") ?? "");
  if (bookingId === "") return failedForm("The form could not be read.");

  try {
    const booking = await confirmBooking(bookingId);
    revalidatePath("/appointments");
    return succeededForm({ bookingId: booking.id, status: booking.status }, "Hold confirmed.");
  } catch (error) {
    /* The hold lapsed before it was confirmed — by then it is somebody else's to take. Refresh
       so the released slot reappears as free, and say what happened rather than "conflict". */
    if (refusedWith(error, 409)) {
      revalidatePath("/appointments");
      return failedForm(
        "That hold has lapsed and the slot was released. It is free again for the next caller.",
      );
    }
    return failedForm(failureMessage(error));
  }
};

export const cancelBookingAction = async (
  _previous: BookingState,
  form: FormData,
): Promise<BookingState> => {
  const bookingId = String(form.get("bookingId") ?? "");
  if (bookingId === "") return failedForm("The form could not be read.");

  try {
    const booking = await cancelBooking(bookingId);
    revalidatePath("/appointments");
    return succeededForm({ bookingId: booking.id, status: booking.status }, "Booking cancelled.");
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

export interface ContactMatch {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
}

export type ContactSearchResult =
  | { readonly ok: true; readonly contacts: readonly ContactMatch[] }
  | { readonly ok: false; readonly message: string };

/**
 * Find contacts to attach to a booking.
 *
 * Called directly from the booking dialog rather than through a form — there is nothing to
 * submit, just a lookup as the operator types. Reports failure as a message rather than a
 * thrown error, so a picker whose search fails degrades to "no matches" instead of taking the
 * dialog down. Attaching a contact is optional, so this never blocks a booking.
 */
export const findContacts = async (search: string): Promise<ContactSearchResult> => {
  try {
    const { page } = await listContacts(search, { perPage: 10 });
    return {
      ok: true,
      contacts: page.items.map((person) => ({
        id: person.id,
        name: nameOf(person),
        phone: person.phone,
      })),
    };
  } catch (error) {
    return { ok: false, message: failureMessage(error) };
  }
};
