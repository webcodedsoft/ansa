import {
  addHoliday,
  bookSlot,
  cancelBooking,
  confirmHold,
  createCalendar,
  ensureDefaultCalendar,
  expireLapsedHolds,
  readAvailability,
  readBooking,
  readBookings,
  readCalendar,
  readCalendars,
  readHolidays,
  removeHoliday,
  replaceAvailability,
  rescheduleBooking,
  searchBookings,
  SlotTaken,
  type AppointmentCalendar,
  type Booking,
  type Holiday,
  type StoredAvailabilityWindow,
  updateCalendar,
} from "@ansa/db";
import {
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Patch,
  Post,
  Put,
  UnprocessableEntityException,
} from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { apiRoute, FromBody, FromPath, FromQuery } from "../http/request";
import { choice, integer, list, nullable, object, optional, text, type Infer } from "../http/schema";
import { timestamp, uuid } from "../schemas";
import { OrganizationContext } from "../tenancy/organization-context";

import {
  availabilityProblem,
  computeFreeSlots,
  isValidTimezone,
  localDateKey,
  toOffsetIso,
} from "./slots";

/**
 * The diary: calendars, the weekly hours they keep, the free slots those hours leave, and the
 * bookings that fill them.
 *
 * The database layer is deliberately incomplete on purpose (see `packages/db/appointments.ts`):
 * it stores availability as a weekday and minutes past midnight, and it refuses a second
 * booking on the same slot, but it does not know what a slot *is* — expanding a recurring
 * pattern over real dates in a timezone, minus the buffer, minus what is already taken, is
 * arithmetic that needs a timezone library and so lives here, in `slots.ts`. This controller is
 * the seam: it hands that arithmetic its inputs from the scoped queries and projects its answer
 * onto the wire.
 *
 * Every read is offered a current answer: `slots` and the bookings listing expire lapsed holds
 * before they read, so a caller is never refused a time a dropped call never let go of.
 *
 * The holidays (0064) sit here too, under the same capability pair, because a day the office
 * is shut is a fact about calendar availability and nothing else. They are the organisation's,
 * not any one calendar's, so they have no `calendarId` in their paths; `slots` reads the ones
 * covering its range and hands them to the arithmetic.
 */

const CALENDAR_SOURCES = ["hosted", "connector"] as const;
const BOOKING_STATUSES = ["held", "booked", "cancelled"] as const;
const CREATABLE_STATUSES = ["held", "booked"] as const;
const BOOKING_SOURCES = ["call", "manual", "connector"] as const;

const REF_LIMIT = 256;
const NOTES_LIMIT = 4096;
/** Long enough for "Second viewing — 14 Adeola Odeku Street", short enough to draw in a block. */
const TITLE_LIMIT = 200;

const calendar = object({
  id: uuid(),
  name: text({ maxLength: 200 }),
  /** The IANA zone the hours and slots are read in. */
  timezone: text({ maxLength: 64 }),
  slotMinutes: integer({ minimum: 1 }),
  bufferMinutes: integer({ minimum: 0 }),
  source: choice(CALENDAR_SOURCES),
  /** The outside diary's own id, for a connected calendar. Null when hosted. */
  externalRef: nullable(text({ maxLength: REF_LIMIT })),
  createdAt: timestamp(),
  updatedAt: timestamp(),
});

const calendarList = object({ items: list(calendar) });

const newCalendar = object({
  name: text({ minLength: 1, maxLength: 200 }),
  timezone: text({ minLength: 1, maxLength: 64 }),
  slotMinutes: optional(integer({ minimum: 1, maximum: 1440 })),
  bufferMinutes: optional(integer({ minimum: 0, maximum: 1440 })),
  source: optional(choice(CALENDAR_SOURCES)),
  /** Required when `source` is `connector`, refused here rather than by the database's CHECK. */
  externalRef: optional(text({ maxLength: REF_LIMIT })),
});

const calendarEdit = object({
  name: optional(text({ minLength: 1, maxLength: 200 })),
  timezone: optional(text({ minLength: 1, maxLength: 64 })),
  slotMinutes: optional(integer({ minimum: 1, maximum: 1440 })),
  bufferMinutes: optional(integer({ minimum: 0, maximum: 1440 })),
});

const calendarPath = object({ calendarId: uuid() });

/** 0 is Sunday, as `getDay()` and the stored column have it. 1440 is midnight at the day's close. */
const availabilityWindow = object({
  weekday: integer({ minimum: 0, maximum: 6 }),
  startMinute: integer({ minimum: 0, maximum: 1440 }),
  endMinute: integer({ minimum: 0, maximum: 1440 }),
});

const storedWindow = object({
  id: uuid(),
  weekday: integer({ minimum: 0, maximum: 6 }),
  startMinute: integer({ minimum: 0, maximum: 1440 }),
  endMinute: integer({ minimum: 0, maximum: 1440 }),
});

const availability = object({ windows: list(storedWindow) });

const availabilityReplace = object({ windows: list(availabilityWindow, { maxItems: 100 }) });

const rangeQuery = object({ from: timestamp(), to: timestamp() });

const slot = object({ start: timestamp(), end: timestamp() });

const slots = object({ slots: list(slot) });

/** A day, plus the buffer: enough to catch an appointment that ends just before a range. */
const bookingLookback = (bufferMinutes: number): number =>
  24 * 60 * 60_000 + bufferMinutes * 60_000;

const booking = object({
  id: uuid(),
  calendarId: uuid(),
  contactId: nullable(uuid()),
  startsAt: timestamp(),
  endsAt: timestamp(),
  status: choice(BOOKING_STATUSES),
  /** When a hold lapses. Null unless `status` is `held`. */
  holdExpiresAt: nullable(timestamp()),
  source: choice(BOOKING_SOURCES),
  callId: nullable(uuid()),
  /** The connector's own id for this booking, when it mirrored one outward. */
  externalRef: nullable(text({ maxLength: REF_LIMIT })),
  /** What the appointment is, when somebody wrote it down. Null on one a call took. */
  title: nullable(text({ maxLength: TITLE_LIMIT })),
  notes: nullable(text({ maxLength: NOTES_LIMIT })),
  createdAt: timestamp(),
  updatedAt: timestamp(),
});

const bookingList = object({ items: list(booking) });

/**
 * What a search asks for.
 *
 * A short floor on the term because a one-character search returns the whole diary and means
 * nothing; a ceiling on `limit` because this is a lookup box, not an export.
 */
const searchQuery = object({
  q: text({ minLength: 2, maxLength: 200 }),
  limit: optional(integer({ minimum: 1, maximum: 100 })),
});

/**
 * What may be changed about an appointment already in the diary.
 *
 * Every field optional, and absent means "leave it as it is" — moving an appointment must not
 * blank the note somebody attached to it. `startsAt` and `endsAt` travel together or not at
 * all, because half a move is a booking that ends before it starts.
 */
const bookingEdit = object({
  startsAt: optional(timestamp()),
  endsAt: optional(timestamp()),
  title: optional(nullable(text({ maxLength: TITLE_LIMIT }))),
  notes: optional(nullable(text({ maxLength: NOTES_LIMIT }))),
  contactId: optional(nullable(uuid())),
});

const newBooking = object({
  startsAt: timestamp(),
  source: choice(BOOKING_SOURCES),
  /**
   * `booked` takes the slot outright; `held` reserves it until `holdMinutes` elapses, which is
   * how a live call holds a time while the caller decides. Defaults to `booked`.
   */
  status: optional(choice(CREATABLE_STATUSES)),
  /** Required when `status` is `held`: how long the reservation stands before it lapses. */
  holdMinutes: optional(integer({ minimum: 1, maximum: 24 * 60 })),
  /**
   * When it ends. Absent means one slot of the calendar's own length, which is what a call
   * takes; a person writing in the diary drags out whatever length the thing actually is.
   */
  endsAt: optional(timestamp()),
  /** What it is, for the grid to print. A call leaves this out and the contact names the row. */
  title: optional(text({ maxLength: TITLE_LIMIT })),
  contactId: optional(uuid()),
  notes: optional(text({ maxLength: NOTES_LIMIT })),
  /** For a connector calendar: the outside diary's id for this booking. Sync itself is elsewhere. */
  externalRef: optional(text({ maxLength: REF_LIMIT })),
});

const bookingPath = object({ bookingId: uuid() });

/** Only the zone, and even that is optional: everything else about a first calendar is decided. */
const defaultCalendarBody = object({
  timezone: optional(text({ minLength: 1, maxLength: 64 })),
});

/**
 * A calendar date, `YYYY-MM-DD`, with no hour on it.
 *
 * `timestamp()` is deliberately not reused. A holiday is a square on a calendar and an
 * instant would carry an hour that has to be in *some* zone, which is the whole thing
 * migration 0064 refuses to do. The pattern holds the shape; `asCalendarDate` below holds the
 * meaning, because `2026-02-31` matches this happily.
 */
const calendarDate = () =>
  text({ minLength: 10, maxLength: 10, pattern: /^\d{4}-\d{2}-\d{2}$/, format: "date" });

/** Long enough for "Eid al-Fitr (second day)", which is the longest thing anyone writes here. */
const HOLIDAY_NAME_LIMIT = 200;

const holiday = object({
  id: uuid(),
  /** The date the office is shut, in the calendar's own zone. */
  onDate: calendarDate(),
  name: text({ maxLength: HOLIDAY_NAME_LIMIT }),
  createdAt: timestamp(),
  updatedAt: timestamp(),
});

const holidayList = object({ items: list(holiday) });

/** Both ends inclusive, and both optional — absent means the whole list. */
const holidayQuery = object({
  from: optional(calendarDate()),
  to: optional(calendarDate()),
});

const newHoliday = object({
  onDate: calendarDate(),
  name: text({ minLength: 1, maxLength: HOLIDAY_NAME_LIMIT }),
});

const holidayPath = object({ holidayId: uuid() });

@Controller(apiRoute("appointments"))
export class AppointmentsController {
  constructor(@Inject(OrganizationContext) private readonly db: OrganizationContext) {}

  @Get("calendars")
  @Endpoint({
    summary: "List this organisation's calendars",
    description: "Every calendar the organisation holds, oldest first, with its timezone and slot length.",
    capability: "appointments:read",
    response: calendarList,
  })
  async listCalendars(): Promise<Infer<typeof calendarList>> {
    const rows = await this.db.tx((scope) => readCalendars(scope));
    return { items: rows.map(asCalendarBody) };
  }

  /* Before `calendars/:calendarId`, so the literal path is not read as an id. */
  @Post("calendars/default")
  @Endpoint({
    summary: "Make sure this organisation has a calendar",
    description:
      "Idempotent. Creates one calendar, named Appointments, seeded from the organisation's own business hours, and does nothing at all if the organisation already has one. Exists so the appointments screen opens on a diary rather than on a button asking for one; `timezone` may name the zone to keep it in, and defaults to Africa/Lagos.",
    capability: "appointments:write",
    body: defaultCalendarBody,
    response: calendar,
  })
  async ensureCalendar(
    @FromBody() body: Infer<typeof defaultCalendarBody>,
  ): Promise<Infer<typeof calendar>> {
    const timezone = body.timezone ?? "Africa/Lagos";
    if (!isValidTimezone(timezone)) {
      throw new UnprocessableEntityException(`${timezone} is not a known IANA timezone`);
    }
    const made = await this.db.tx(async (scope) => {
      const created = await ensureDefaultCalendar(scope, timezone);
      /* Null means one already existed. Return it rather than a 409 — "make sure there is a
         calendar" is satisfied either way, and a caller that has to branch on which of the
         two happened is a caller doing the idempotency itself. */
      return created ?? (await readCalendars(scope))[0] ?? null;
    });
    if (made === null) throw new UnprocessableEntityException("this organisation has no calendar and one could not be made");
    return asCalendarBody(made);
  }

  @Post("calendars")
  @Endpoint({
    summary: "Create a calendar",
    description:
      "`timezone` must be a real IANA zone — the availability and slots are read in it. A `connector` calendar mirrors an outside diary and must carry that diary's `externalRef`; a `hosted` one is kept here.",
    capability: "appointments:write",
    body: newCalendar,
    response: calendar,
    status: 201,
  })
  async createCalendar(@FromBody() body: Infer<typeof newCalendar>): Promise<Infer<typeof calendar>> {
    if (!isValidTimezone(body.timezone)) {
      throw new UnprocessableEntityException(`${body.timezone} is not a known IANA timezone`);
    }
    if (body.source === "connector" && (body.externalRef === undefined || body.externalRef.trim() === "")) {
      throw new UnprocessableEntityException("a connector calendar needs an externalRef");
    }
    const created = await this.db.tx((scope) =>
      createCalendar(scope, {
        name: body.name,
        timezone: body.timezone,
        slotMinutes: body.slotMinutes,
        bufferMinutes: body.bufferMinutes,
        source: body.source,
        externalRef: body.externalRef ?? null,
      }),
    );
    return asCalendarBody(created);
  }

  @Get("calendars/:calendarId")
  @Endpoint({
    summary: "Read one calendar",
    capability: "appointments:read",
    params: calendarPath,
    response: calendar,
  })
  async readCalendar(@FromPath() path: Infer<typeof calendarPath>): Promise<Infer<typeof calendar>> {
    const found = await this.db.tx((scope) => readCalendar(scope, path.calendarId));
    // Not ours, which under RLS is also what another organisation's calendar looks like.
    if (found === null) throw new NotFoundException();
    return asCalendarBody(found);
  }

  @Patch("calendars/:calendarId")
  @Endpoint({
    summary: "Edit a calendar",
    description: "Only the fields sent change. `timezone`, if sent, must be a real IANA zone.",
    capability: "appointments:write",
    params: calendarPath,
    body: calendarEdit,
    response: calendar,
  })
  async editCalendar(
    @FromPath() path: Infer<typeof calendarPath>,
    @FromBody() body: Infer<typeof calendarEdit>,
  ): Promise<Infer<typeof calendar>> {
    if (body.timezone !== undefined && !isValidTimezone(body.timezone)) {
      throw new UnprocessableEntityException(`${body.timezone} is not a known IANA timezone`);
    }
    const updated = await this.db.tx(async (scope) => {
      const changed = await updateCalendar(scope, path.calendarId, body);
      return changed ? readCalendar(scope, path.calendarId) : null;
    });
    if (updated === null) throw new NotFoundException();
    return asCalendarBody(updated);
  }

  @Get("calendars/:calendarId/availability")
  @Endpoint({
    summary: "Read a calendar's weekly hours",
    capability: "appointments:read",
    params: calendarPath,
    response: availability,
  })
  async readAvailability(
    @FromPath() path: Infer<typeof calendarPath>,
  ): Promise<Infer<typeof availability>> {
    const found = await this.db.tx(async (scope) => {
      const cal = await readCalendar(scope, path.calendarId);
      if (cal === null) return null;
      return readAvailability(scope, path.calendarId);
    });
    if (found === null) throw new NotFoundException();
    return { windows: found.map(asWindowBody) };
  }

  @Put("calendars/:calendarId/availability")
  @Endpoint({
    summary: "Replace a calendar's weekly hours",
    description:
      "The whole week at once, the way it is edited: everything the calendar had goes, and what is sent takes its place. Each window must end after it starts, and windows on the same weekday must not overlap.",
    capability: "appointments:write",
    params: calendarPath,
    body: availabilityReplace,
    response: availability,
  })
  async replaceAvailability(
    @FromPath() path: Infer<typeof calendarPath>,
    @FromBody() body: Infer<typeof availabilityReplace>,
  ): Promise<Infer<typeof availability>> {
    const problem = availabilityProblem(body.windows);
    if (problem !== null) throw new UnprocessableEntityException(problem);
    const stored = await this.db.tx(async (scope) => {
      const cal = await readCalendar(scope, path.calendarId);
      if (cal === null) return null;
      return replaceAvailability(scope, path.calendarId, body.windows);
    });
    if (stored === null) throw new NotFoundException();
    return { windows: stored.map(asWindowBody) };
  }

  @Get("calendars/:calendarId/slots")
  @Endpoint({
    summary: "The free slots in a range",
    description:
      "The recurring hours expanded over the range in the calendar's timezone, minus the buffer, minus every live booking and unexpired hold, minus every day the organisation is shut. Lapsed holds are released first, so a slot a dropped call never let go of is offered again. A public holiday yields nothing at all — an appointment already written on one is still listed by the bookings endpoint, because withholding the offer is not the same as forbidding the booking. Each slot's start and end carry the calendar's own offset.",
    capability: "appointments:read",
    params: calendarPath,
    query: rangeQuery,
    response: slots,
  })
  async slots(
    @FromPath() path: Infer<typeof calendarPath>,
    @FromQuery() query: Infer<typeof rangeQuery>,
  ): Promise<Infer<typeof slots>> {
    const { from, to } = asRange(query);
    const computed = await this.db.tx(async (scope) => {
      const cal = await readCalendar(scope, path.calendarId);
      if (cal === null) return null;
      const windows = await readAvailability(scope, path.calendarId);
      await expireLapsedHolds(scope, path.calendarId, new Date());
      /* Widened by the buffer, and by a day at the start.
       *
       * `readBookings` keeps a row only while `ends_at > from`, so a booking that finishes on
       * or before the range start is never loaded — and `computeFreeSlots` cannot apply a
       * buffer to a booking it was not given. With a 30-minute buffer and an appointment
       * ending at 09:00, asking from 09:00 offered 09:00 itself, inside the dead time either
       * side of it. The day at the start also covers a long appointment that began before the
       * range and is still running into it. */
      const guard = bookingLookback(cal.bufferMinutes);
      const bookings = await readBookings(scope, path.calendarId, {
        from: new Date(from.getTime() - guard),
        to: new Date(to.getTime() + cal.bufferMinutes * 60_000),
      });
      /* The days the range covers *in this calendar's zone*, which is not always the days it
         covers in UTC — half past eleven at night in Lagos is already tomorrow in Kiritimati
         and still today in London. Asking in the calendar's zone is what makes the holiday
         land on the day the caller would actually be offered. */
      const shut = await readHolidays(scope, {
        from: localDateKey(from, cal.timezone),
        to: localDateKey(to, cal.timezone),
      });
      return { cal, windows, bookings, shut };
    });
    if (computed === null) throw new NotFoundException();
    const free = computeFreeSlots({
      timeZone: computed.cal.timezone,
      slotMinutes: computed.cal.slotMinutes,
      bufferMinutes: computed.cal.bufferMinutes,
      windows: computed.windows,
      bookings: computed.bookings,
      holidays: computed.shut.map((day) => day.onDate),
      from,
      to,
    });
    return {
      slots: free.map((entry) => ({
        start: toOffsetIso(entry.start, computed.cal.timezone),
        end: toOffsetIso(entry.end, computed.cal.timezone),
      })),
    };
  }

  @Get("calendars/:calendarId/bookings")
  @Endpoint({
    summary: "The bookings in a range",
    description:
      "Every live booking and hold whose time overlaps the range, cancelled ones excluded. Lapsed holds are released first, so the list is what is actually taken now.",
    capability: "appointments:read",
    params: calendarPath,
    query: rangeQuery,
    response: bookingList,
  })
  async listBookings(
    @FromPath() path: Infer<typeof calendarPath>,
    @FromQuery() query: Infer<typeof rangeQuery>,
  ): Promise<Infer<typeof bookingList>> {
    const { from, to } = asRange(query);
    const found = await this.db.tx(async (scope) => {
      const cal = await readCalendar(scope, path.calendarId);
      if (cal === null) return null;
      await expireLapsedHolds(scope, path.calendarId, new Date());
      return readBookings(scope, path.calendarId, { from, to });
    });
    if (found === null) throw new NotFoundException();
    return { items: found.map(asBookingBody) };
  }

  /* Before any `bookings/:something` route would be, so a literal path is never swallowed by
     a parameter. There is no such GET route today; this comment is here because adding one
     later without noticing would break search silently. */
  @Get("bookings/search")
  @Endpoint({
    summary: "Find appointments by name",
    description:
      "Matches the title and the note, across every calendar the organisation keeps, ignoring the dates on screen — the point is to find an appointment whose week you do not know. Cancelled appointments are excluded. Newest first.",
    capability: "appointments:read",
    query: searchQuery,
    response: bookingList,
  })
  async search(
    @FromQuery() query: Infer<typeof searchQuery>,
  ): Promise<Infer<typeof bookingList>> {
    const term = query.q.trim();
    if (term.length < 2) return { items: [] };
    const found = await this.db.tx((scope) => searchBookings(scope, term, query.limit ?? 25));
    return { items: found.map(asBookingBody) };
  }

  @Post("calendars/:calendarId/bookings")
  @Endpoint({
    summary: "Book or hold a slot",
    description:
      "Takes a free slot at `startsAt`; the slot's length is the calendar's. `booked` takes it outright, `held` reserves it for `holdMinutes` while a caller decides. If the slot was taken between being offered and being booked, this answers 409 — offer the next one.",
    capability: "appointments:write",
    params: calendarPath,
    body: newBooking,
    response: booking,
    status: 201,
  })
  async createBooking(
    @FromPath() path: Infer<typeof calendarPath>,
    @FromBody() body: Infer<typeof newBooking>,
  ): Promise<Infer<typeof booking>> {
    const startsAt = asTimestamp(body.startsAt, "startsAt");
    const status = body.status ?? "booked";
    if (status === "held" && body.holdMinutes === undefined) {
      throw new UnprocessableEntityException("a held booking needs holdMinutes");
    }
    const now = new Date();
    const holdExpiresAt =
      status === "held" && body.holdMinutes !== undefined
        ? new Date(now.getTime() + body.holdMinutes * 60000)
        : null;

    const made = await this.db.tx(async (scope) => {
      const cal = await readCalendar(scope, path.calendarId);
      if (cal === null) return null;
      /* The length the caller asked for, or one slot. A slot is what a call takes, because
         that is what the agent offered; a person at the desk says when it ends. */
      const endsAt =
        body.endsAt === undefined
          ? new Date(startsAt.getTime() + cal.slotMinutes * 60000)
          : asTimestamp(body.endsAt, "endsAt");
      if (endsAt.getTime() <= startsAt.getTime()) return "backwards" as const;
      return bookSlot(scope, {
        calendarId: path.calendarId,
        startsAt,
        endsAt,
        status,
        holdExpiresAt,
        contactId: body.contactId ?? null,
        source: body.source,
        externalRef: body.externalRef ?? null,
        title: body.title ?? null,
        notes: body.notes ?? null,
      });
    }).catch((error: unknown) => {
      if (error instanceof SlotTaken) {
        throw new ConflictException("that slot is no longer free — offer the next one");
      }
      throw error;
    });
    if (made === "backwards") {
      throw new UnprocessableEntityException("an appointment must end after it starts");
    }
    if (made === null) throw new NotFoundException();
    return asBookingBody(made);
  }

  @Post("bookings/:bookingId/confirm")
  @Endpoint({
    summary: "Confirm a held slot",
    description:
      "Turns a hold into a booking. A hold that has already lapsed cannot be confirmed — it is somebody else's to take by then — and this answers 409 rather than putting two people in one chair.",
    capability: "appointments:write",
    params: bookingPath,
    response: booking,
  })
  async confirmBooking(@FromPath() path: Infer<typeof bookingPath>): Promise<Infer<typeof booking>> {
    const now = new Date();
    const confirmed = await this.db.tx(async (scope) => {
      const existing = await readBooking(scope, path.bookingId);
      if (existing === null) return { outcome: "missing" as const };
      if (existing.status !== "held") return { outcome: "not-held" as const };
      if (existing.holdExpiresAt === null || existing.holdExpiresAt.getTime() <= now.getTime()) {
        return { outcome: "lapsed" as const };
      }
      const ok = await confirmHold(scope, path.bookingId, now);
      // False now can only mean it lapsed in the moment between the read and the update.
      if (!ok) return { outcome: "lapsed" as const };
      return { outcome: "confirmed" as const, booking: await readBooking(scope, path.bookingId) };
    });
    if (confirmed.outcome === "missing") throw new NotFoundException();
    if (confirmed.outcome === "not-held") {
      throw new ConflictException("only a held booking can be confirmed");
    }
    if (confirmed.outcome === "lapsed") {
      throw new ConflictException("that hold has lapsed and can no longer be confirmed");
    }
    if (confirmed.booking === null) throw new NotFoundException();
    return asBookingBody(confirmed.booking);
  }

  @Patch("bookings/:bookingId")
  @Endpoint({
    summary: "Move, resize or rename an appointment",
    description:
      "What dragging a block on the grid comes down to. Absent fields are left alone; a null title, note or contact clears it. Times move together — a start without an end is a 422. Landing on a minute another live appointment already starts on is a 409, the same refusal booking a taken slot gets. A cancelled appointment cannot be moved; book it again instead.",
    capability: "appointments:write",
    params: bookingPath,
    body: bookingEdit,
    response: booking,
  })
  async editBooking(
    @FromPath() path: Infer<typeof bookingPath>,
    @FromBody() body: Infer<typeof bookingEdit>,
  ): Promise<Infer<typeof booking>> {
    const moving = body.startsAt !== undefined || body.endsAt !== undefined;
    if (moving && (body.startsAt === undefined || body.endsAt === undefined)) {
      throw new UnprocessableEntityException("moving an appointment needs both startsAt and endsAt");
    }
    const startsAt = body.startsAt === undefined ? undefined : asTimestamp(body.startsAt, "startsAt");
    const endsAt = body.endsAt === undefined ? undefined : asTimestamp(body.endsAt, "endsAt");
    if (startsAt !== undefined && endsAt !== undefined && endsAt.getTime() <= startsAt.getTime()) {
      throw new UnprocessableEntityException("an appointment must end after it starts");
    }

    const moved = await this.db
      .tx((scope) =>
        rescheduleBooking(scope, path.bookingId, {
          ...(startsAt === undefined ? {} : { startsAt }),
          ...(endsAt === undefined ? {} : { endsAt }),
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.notes === undefined ? {} : { notes: body.notes }),
          ...(body.contactId === undefined ? {} : { contactId: body.contactId }),
        }),
      )
      .catch((error: unknown) => {
        if (error instanceof SlotTaken) {
          throw new ConflictException("something else already starts at that time");
        }
        throw error;
      });
    if (moved === null) throw new NotFoundException();
    return asBookingBody(moved);
  }

  @Post("bookings/:bookingId/cancel")
  @Endpoint({
    summary: "Cancel a booking or hold",
    description:
      "The slot is freed for the next caller. Cancelling something already cancelled is not an error — the state asked for is the state it is in.",
    capability: "appointments:write",
    params: bookingPath,
    response: booking,
  })
  async cancelBooking(@FromPath() path: Infer<typeof bookingPath>): Promise<Infer<typeof booking>> {
    const cancelled = await this.db.tx(async (scope) => {
      const existing = await readBooking(scope, path.bookingId);
      if (existing === null) return null;
      await cancelBooking(scope, path.bookingId);
      return readBooking(scope, path.bookingId);
    });
    if (cancelled === null) throw new NotFoundException();
    return asBookingBody(cancelled);
  }

  @Get("holidays")
  @Endpoint({
    summary: "The days this organisation is shut",
    description:
      "Every date the organisation keeps closed, earliest first, with the name it gave each one. Organisation-wide: every calendar it holds is shut on these days. `from` and `to` are calendar dates, `YYYY-MM-DD`, and both ends are included; send neither for the whole list.",
    capability: "appointments:read",
    query: holidayQuery,
    response: holidayList,
  })
  async listHolidays(
    @FromQuery() query: Infer<typeof holidayQuery>,
  ): Promise<Infer<typeof holidayList>> {
    const range = asDateRange(query);
    const rows = await this.db.tx((scope) => readHolidays(scope, range));
    return { items: rows.map(asHolidayBody) };
  }

  @Post("holidays")
  @Endpoint({
    summary: "Mark a date shut",
    description:
      "`onDate` is a calendar date, `YYYY-MM-DD`, with no time on it — a holiday is a square on a calendar and it begins at midnight wherever the calendar is kept. From then on no calendar in this organisation offers a slot on that day. Existing appointments on it are left alone and a person may still write a new one, which is how an office that opens specially records it. A date already marked shut answers 409; there is no recurrence rule, so next year's Christmas is next year's row.",
    capability: "appointments:write",
    body: newHoliday,
    response: holiday,
    status: 201,
  })
  async addHoliday(@FromBody() body: Infer<typeof newHoliday>): Promise<Infer<typeof holiday>> {
    const onDate = asCalendarDate(body.onDate, "onDate");
    const added = await this.db.tx((scope) => addHoliday(scope, { onDate, name: body.name }));
    if (added === null) {
      throw new ConflictException(`${onDate} is already marked as a day this organisation is shut`);
    }
    return asHolidayBody(added);
  }

  @Delete("holidays/:holidayId")
  @Endpoint({
    summary: "The office is open that day after all",
    description:
      "Removes the date outright rather than hiding it — a holiday is a statement about the future, and one that still suppressed slots after being deleted would be worse than none. Slots on that day are offered again from the next request.",
    capability: "appointments:write",
    params: holidayPath,
  })
  async removeHoliday(@FromPath() path: Infer<typeof holidayPath>): Promise<void> {
    const removed = await this.db.tx((scope) => removeHoliday(scope, path.holidayId));
    // Not ours, which under RLS is also what another organisation's holiday looks like.
    if (!removed) throw new NotFoundException();
  }
}

/** A query timestamp, refused rather than silently treated as the epoch. */
const asTimestamp = (value: string, field: string): Date => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new UnprocessableEntityException(`${field} must be a timestamp`);
  }
  return parsed;
};

/**
 * A calendar date that is a date somebody could stand on, not merely one that looks like one.
 *
 * The schema's pattern accepts `2026-02-31` and `2026-13-01`; Postgres would then refuse the
 * `::date` cast mid-transaction and the caller would get a 500 for what is plainly their
 * mistake. Round-tripping through UTC catches it: a real date renders back as itself, and
 * February the thirty-first renders back as March the third.
 */
const asCalendarDate = (value: string, field: string): string => {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new UnprocessableEntityException(`${field} must be a calendar date, as YYYY-MM-DD`);
  }
  return value;
};

/**
 * The optional `from`/`to` of a holidays listing, or undefined for the whole list.
 *
 * Both ends or neither: half a range is almost always a console bug, and answering it with
 * everything from the start of time reads as the filter having silently failed.
 */
const asDateRange = (
  query: Infer<typeof holidayQuery>,
): { from: string; to: string } | undefined => {
  if (query.from === undefined && query.to === undefined) return undefined;
  if (query.from === undefined || query.to === undefined) {
    throw new UnprocessableEntityException("send both from and to, or neither");
  }
  const from = asCalendarDate(query.from, "from");
  const to = asCalendarDate(query.to, "to");
  if (from > to) throw new UnprocessableEntityException("from must not be after to");
  return { from, to };
};

/** A `from`/`to` pair, both real timestamps and in order. */
const asRange = (query: Infer<typeof rangeQuery>): { from: Date; to: Date } => {
  const from = asTimestamp(query.from, "from");
  const to = asTimestamp(query.to, "to");
  if (from.getTime() >= to.getTime()) {
    throw new UnprocessableEntityException("from must be before to");
  }
  return { from, to };
};

const asCalendarBody = (row: AppointmentCalendar): Infer<typeof calendar> => ({
  id: row.id,
  name: row.name,
  timezone: row.timezone,
  slotMinutes: row.slotMinutes,
  bufferMinutes: row.bufferMinutes,
  source: row.source,
  externalRef: row.externalRef,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const asHolidayBody = (row: Holiday): Infer<typeof holiday> => ({
  id: row.id,
  // Already `YYYY-MM-DD` out of the query, and deliberately never a `Date` on the way here.
  onDate: row.onDate,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const asWindowBody = (row: StoredAvailabilityWindow): Infer<typeof storedWindow> => ({
  id: row.id,
  weekday: row.weekday,
  startMinute: row.startMinute,
  endMinute: row.endMinute,
});

const asBookingBody = (row: Booking): Infer<typeof booking> => ({
  id: row.id,
  calendarId: row.calendarId,
  contactId: row.contactId,
  startsAt: row.startsAt.toISOString(),
  endsAt: row.endsAt.toISOString(),
  status: row.status,
  holdExpiresAt: row.holdExpiresAt?.toISOString() ?? null,
  source: row.source,
  callId: row.callId,
  externalRef: row.externalRef,
  title: row.title,
  notes: row.notes,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
