import type { OrganizationScope } from "./organization-scope";

/**
 * A place in the diary (0062).
 *
 * Diaries, the weekly hours they are open, and the appointments in them. Same shape as the
 * other files here: every function takes an `OrganizationScope`, every insert reads
 * `app.current_organization()`, RLS filters the rest.
 *
 * What this does *not* do is turn hours into slots. "Thursday at two is free" is the weekly
 * pattern expanded over real dates in the diary's timezone, minus the bookings, minus the
 * buffer — arithmetic that belongs beside the timezone library in the API rather than in
 * SQL that cannot see one. This file gives that arithmetic its inputs and takes its answer.
 *
 * The one rule the database keeps for itself is the one that needs the database: two calls
 * cannot take the same slot, because `appointment_bookings_one_per_slot_idx` says so, and
 * `bookSlot` turns that refusal into `SlotTaken`.
 */

/** `appointment_calendars_source_check` is the enforcement. */
export type CalendarSource = "hosted" | "connector";
/** `appointment_bookings_status_check` is the enforcement. */
export type BookingStatus = "held" | "booked" | "cancelled";
/** `appointment_bookings_source_check` is the enforcement. */
export type BookingSource = "call" | "manual" | "connector";

/** Postgres' code for a unique index violation. */
const UNIQUE_VIOLATION = "23505";

const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

const constraintOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "constraint" in error
    ? String((error as { constraint?: unknown }).constraint)
    : undefined;

/**
 * Raised when the slot went to somebody else between offering it and taking it.
 *
 * Not a bug: two callers were told Thursday at two was free and one of them said yes first.
 * The caller of `bookSlot` offers the next one.
 */
export class SlotTaken extends Error {
  constructor(
    readonly calendarId: string,
    readonly startsAt: Date,
  ) {
    super(`Slot is already taken: ${startsAt.toISOString()}`);
    this.name = "SlotTaken";
  }
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

export interface AppointmentCalendar {
  readonly id: string;
  readonly name: string;
  /** IANA zone the availability windows are in. */
  readonly timezone: string;
  readonly slotMinutes: number;
  readonly bufferMinutes: number;
  readonly source: CalendarSource;
  /** The outside diary's own id, for a connected calendar. Null when hosted. */
  readonly externalRef: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const CALENDAR_COLUMNS =
  "id, name, timezone, slot_minutes, buffer_minutes, source, external_ref, created_at, updated_at";

const asCalendar = (row: Record<string, unknown>): AppointmentCalendar => ({
  id: String(row["id"]),
  name: String(row["name"]),
  timezone: String(row["timezone"]),
  slotMinutes: Number(row["slot_minutes"]),
  bufferMinutes: Number(row["buffer_minutes"]),
  source: String(row["source"]) as CalendarSource,
  externalRef: row["external_ref"] === null ? null : String(row["external_ref"]),
  createdAt: new Date(String(row["created_at"])),
  updatedAt: new Date(String(row["updated_at"])),
});

export interface NewCalendar {
  readonly name: string;
  readonly timezone: string;
  readonly slotMinutes?: number;
  readonly bufferMinutes?: number;
  readonly source?: CalendarSource;
  /** Required by `appointment_calendars_connector_has_ref` when `source` is `connector`. */
  readonly externalRef?: string | null;
}

export const createCalendar = async (
  scope: OrganizationScope,
  input: NewCalendar,
): Promise<AppointmentCalendar> => {
  const rows = await scope.query<Record<string, unknown>>(
    `insert into appointment_calendars
       (organization_id, name, timezone, slot_minutes, buffer_minutes, source, external_ref)
     values (app.current_organization(), $1, $2, coalesce($3, 30), coalesce($4, 0),
             coalesce($5, 'hosted'), $6)
     returning ${CALENDAR_COLUMNS}`,
    [
      input.name,
      input.timezone,
      input.slotMinutes ?? null,
      input.bufferMinutes ?? null,
      input.source ?? null,
      input.externalRef ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("Insert returned no row — the organization scope is wrong.");
  return asCalendar(row);
};

export const readCalendars = async (
  scope: OrganizationScope,
): Promise<readonly AppointmentCalendar[]> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select ${CALENDAR_COLUMNS} from appointment_calendars order by created_at, id`,
  );
  return rows.map(asCalendar);
};

export const readCalendar = async (
  scope: OrganizationScope,
  calendarId: string,
): Promise<AppointmentCalendar | null> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select ${CALENDAR_COLUMNS} from appointment_calendars where id = $1`,
    [calendarId],
  );
  const row = rows[0];
  return row === undefined ? null : asCalendar(row);
};

export interface CalendarEdit {
  readonly name?: string;
  readonly timezone?: string;
  readonly slotMinutes?: number;
  readonly bufferMinutes?: number;
}

export const updateCalendar = async (
  scope: OrganizationScope,
  calendarId: string,
  edit: CalendarEdit,
): Promise<boolean> => {
  const rows = await scope.mutate<Record<string, unknown>>(
    `update appointment_calendars
        set name           = coalesce($2, name),
            timezone       = coalesce($3, timezone),
            slot_minutes   = coalesce($4, slot_minutes),
            buffer_minutes = coalesce($5, buffer_minutes)
      where id = $1
      returning id`,
    [
      calendarId,
      edit.name ?? null,
      edit.timezone ?? null,
      edit.slotMinutes ?? null,
      edit.bufferMinutes ?? null,
    ],
  );
  return rows.length > 0;
};

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export interface AvailabilityWindow {
  /** 0 is Sunday, as `getDay()` has it. */
  readonly weekday: number;
  /** Minutes past midnight in the calendar's timezone. 540 is nine in the morning. */
  readonly startMinute: number;
  /** Exclusive. 1440 is midnight at the close of the day. */
  readonly endMinute: number;
}

export interface StoredAvailabilityWindow extends AvailabilityWindow {
  readonly id: string;
}

const asWindow = (row: Record<string, unknown>): StoredAvailabilityWindow => ({
  id: String(row["id"]),
  weekday: Number(row["weekday"]),
  startMinute: Number(row["start_minute"]),
  endMinute: Number(row["end_minute"]),
});

export const readAvailability = async (
  scope: OrganizationScope,
  calendarId: string,
): Promise<readonly StoredAvailabilityWindow[]> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select id, weekday, start_minute, end_minute
       from appointment_availability
      where calendar_id = $1
      order by weekday, start_minute`,
    [calendarId],
  );
  return rows.map(asWindow);
};

/**
 * Replace the whole week.
 *
 * The opening hours are edited as one screen and saved as one statement, so they are
 * written the same way: everything the calendar had goes, and what was submitted goes in.
 * Editing windows one at a time would let a save land half-applied, and the agent would
 * offer Tuesday mornings from the old week and Tuesday afternoons from the new one.
 *
 * The organisation id is read from the calendar row, so a calendar id from another
 * organisation writes nothing — RLS hides the row and the insert selects no calendar.
 */
export const replaceAvailability = async (
  scope: OrganizationScope,
  calendarId: string,
  windows: readonly AvailabilityWindow[],
): Promise<readonly StoredAvailabilityWindow[]> => {
  await scope.query(`delete from appointment_availability where calendar_id = $1`, [calendarId]);
  if (windows.length === 0) return [];
  const rows = await scope.query<Record<string, unknown>>(
    `insert into appointment_availability
       (organization_id, calendar_id, weekday, start_minute, end_minute)
     select c.organization_id, c.id, w.weekday, w.start_minute, w.end_minute
       from appointment_calendars c
       cross join unnest($2::int[], $3::int[], $4::int[]) as w(weekday, start_minute, end_minute)
      where c.id = $1
     returning id, weekday, start_minute, end_minute`,
    [
      calendarId,
      windows.map((w) => w.weekday),
      windows.map((w) => w.startMinute),
      windows.map((w) => w.endMinute),
    ],
  );
  return rows.map(asWindow);
};

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export interface Booking {
  readonly id: string;
  readonly calendarId: string;
  readonly contactId: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: BookingStatus;
  /** When a hold lapses. Null unless `status` is `held`. */
  readonly holdExpiresAt: Date | null;
  readonly source: BookingSource;
  readonly callId: string | null;
  readonly externalRef: string | null;
  /** What the appointment is, when a person wrote it down. Absent on one a call took. */
  readonly title: string | null;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const BOOKING_COLUMNS = `
  id, calendar_id, contact_id, starts_at, ends_at, status, hold_expires_at, source, call_id,
  external_ref, title, notes, created_at, updated_at`;

const asBooking = (row: Record<string, unknown>): Booking => ({
  id: String(row["id"]),
  calendarId: String(row["calendar_id"]),
  contactId: row["contact_id"] === null ? null : String(row["contact_id"]),
  startsAt: new Date(String(row["starts_at"])),
  endsAt: new Date(String(row["ends_at"])),
  status: String(row["status"]) as BookingStatus,
  holdExpiresAt: row["hold_expires_at"] === null ? null : new Date(String(row["hold_expires_at"])),
  source: String(row["source"]) as BookingSource,
  callId: row["call_id"] === null ? null : String(row["call_id"]),
  externalRef: row["external_ref"] === null ? null : String(row["external_ref"]),
  title: row["title"] === null || row["title"] === undefined ? null : String(row["title"]),
  notes: row["notes"] === null ? null : String(row["notes"]),
  createdAt: new Date(String(row["created_at"])),
  updatedAt: new Date(String(row["updated_at"])),
});

/**
 * Everything live in a diary between two instants, for the slot arithmetic to subtract.
 *
 * Cancelled rows are not returned; they take no slot. A lapsed hold *is* returned, because
 * it still holds the index until something cancels it — call `expireLapsedHolds` first if
 * the answer must be current, which for a caller being offered a time it must.
 */
export const readBookings = async (
  scope: OrganizationScope,
  calendarId: string,
  range: { readonly from: Date; readonly to: Date },
): Promise<readonly Booking[]> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select ${BOOKING_COLUMNS}
       from appointment_bookings
      where calendar_id = $1
        and status <> 'cancelled'
        and starts_at < $3
        and ends_at > $2
      order by starts_at, id`,
    [calendarId, range.from, range.to],
  );
  return rows.map(asBooking);
};

/**
 * Find appointments by what they are called, across every calendar the organisation keeps.
 *
 * The week grid answers "what is on this week"; this answers "when is the Adeola viewing",
 * which is the question that otherwise costs a person twenty clicks through the weeks. It
 * deliberately spans calendars and ignores the date window: a search that only looked at the
 * fortnight already on screen would fail at exactly the moment it is reached for.
 *
 * `ilike` on title and notes rather than full-text search. The corpus is one organisation's
 * appointment titles, a substring is what a person means by searching a diary ("adeola" must
 * find "14 Adeola Odeku"), and a tsquery would stem and tokenise its way out of matching the
 * partial words somebody types. Cancelled rows are excluded — they are not appointments any
 * more, and returning them would offer a time that is not kept.
 *
 * Scoped by `OrganizationScope`, so RLS answers the tenancy question rather than a `where`
 * clause anybody could forget: an organisation cannot search another's diary.
 */
export const searchBookings = async (
  scope: OrganizationScope,
  term: string,
  limit: number,
): Promise<readonly Booking[]> => {
  /* Escape the wildcards so a caller searching for "50%" is not handed the whole diary. */
  const escaped = term.replace(/[\\%_]/g, (match) => `\\${match}`);
  const rows = await scope.query<Record<string, unknown>>(
    `select ${BOOKING_COLUMNS}
       from appointment_bookings
      where status <> 'cancelled'
        and (title ilike $1 escape '\\' or notes ilike $1 escape '\\')
      order by starts_at desc, id
      limit $2`,
    [`%${escaped}%`, limit],
  );
  return rows.map(asBooking);
};

export const readBooking = async (
  scope: OrganizationScope,
  bookingId: string,
): Promise<Booking | null> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select ${BOOKING_COLUMNS} from appointment_bookings where id = $1`,
    [bookingId],
  );
  const row = rows[0];
  return row === undefined ? null : asBooking(row);
};

/**
 * Free the slots held by calls that never said yes.
 *
 * Cancelled rather than deleted: a hold that lapsed is a thing that happened on a call, and
 * the recording may be asked why the caller was offered a time and then told it was gone.
 */
export const expireLapsedHolds = async (
  scope: OrganizationScope,
  calendarId: string,
  now: Date,
): Promise<number> => {
  const rows = await scope.mutate<Record<string, unknown>>(
    `update appointment_bookings
        set status = 'cancelled'
      where calendar_id = $1 and status = 'held' and hold_expires_at <= $2
      returning id`,
    [calendarId, now],
  );
  return rows.length;
};

export interface NewBooking {
  readonly calendarId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** `held` needs `holdExpiresAt`; `appointment_bookings_hold_lapses` refuses it otherwise. */
  readonly status: Exclude<BookingStatus, "cancelled">;
  readonly holdExpiresAt?: Date | null;
  readonly contactId?: string | null;
  readonly source?: BookingSource;
  readonly callId?: string | null;
  readonly externalRef?: string | null;
  readonly title?: string | null;
  readonly notes?: string | null;
}

/**
 * Take a slot, or learn that somebody else has.
 *
 * A hold that lapsed on this exact slot is cancelled first, so a caller is not refused a
 * time because a call that dropped ten minutes ago never let go of it. Then the insert,
 * and the unique index decides: a second live row at the same instant in the same diary
 * comes back as `SlotTaken`. Any other refusal — a hold with no expiry, an end before its
 * start — is the caller's bug and is thrown as it came.
 *
 * The organisation id is the calendar's, read in the same statement, so a booking cannot
 * be written into a diary this organisation does not hold.
 *
 * The insert runs under a savepoint. A refused insert aborts the transaction it is in, and
 * the transaction here is the caller's whole `withOrganization` — so without the savepoint,
 * `SlotTaken` would be an error the caller could catch but could not recover from, because
 * the next query, "then offer them half past", would fail with "current transaction is
 * aborted". Rolling back to the savepoint leaves the transaction usable and the expired
 * hold above still cancelled.
 */
export const bookSlot = async (scope: OrganizationScope, input: NewBooking): Promise<Booking> => {
  await scope.mutate(
    `update appointment_bookings
        set status = 'cancelled'
      where calendar_id = $1 and starts_at = $2 and status = 'held' and hold_expires_at <= now()
      returning id`,
    [input.calendarId, input.startsAt],
  );

  await scope.query("savepoint book_slot");
  let rows: Record<string, unknown>[];
  try {
    rows = await scope.query<Record<string, unknown>>(
      `insert into appointment_bookings
         (organization_id, calendar_id, contact_id, starts_at, ends_at, status, hold_expires_at,
          source, call_id, external_ref, title, notes)
       select c.organization_id, c.id, $2, $3, $4, $5, $6, coalesce($7, 'call'), $8, $9, $10, $11
         from appointment_calendars c
        where c.id = $1
       returning ${BOOKING_COLUMNS}`,
      [
        input.calendarId,
        input.contactId ?? null,
        input.startsAt,
        input.endsAt,
        input.status,
        input.holdExpiresAt ?? null,
        input.source ?? null,
        input.callId ?? null,
        input.externalRef ?? null,
        input.title?.trim() || null,
        input.notes?.trim() || null,
      ],
    );
  } catch (error: unknown) {
    await scope.query("rollback to savepoint book_slot");
    if (
      codeOf(error) === UNIQUE_VIOLATION &&
      constraintOf(error) === "appointment_bookings_one_per_slot_idx"
    ) {
      throw new SlotTaken(input.calendarId, input.startsAt);
    }
    throw error;
  }
  await scope.query("release savepoint book_slot");

  const row = rows[0];
  if (row === undefined) {
    // The select found no calendar: not this organisation's, or not there at all.
    throw new Error(`No such calendar: ${input.calendarId}`);
  }
  return asBooking(row);
};

/**
 * The caller said yes.
 *
 * Only a hold that has not lapsed can be confirmed. One that has is already somebody
 * else's to take, and confirming it would put two people in the same chair — the exact
 * thing the index exists to stop, reached by a different door.
 */
/**
 * What a person may change about an appointment after writing it down.
 *
 * Every field optional and absent means "leave it": moving an appointment must not blank the
 * note attached to it, and retitling one must not move it. `null` is a value here — it clears
 * the title, the note or the contact — which is why absent and null are told apart rather than
 * folded together the way a partial update usually folds them.
 */
export interface BookingEdit {
  readonly startsAt?: Date;
  readonly endsAt?: Date;
  readonly title?: string | null;
  readonly notes?: string | null;
  readonly contactId?: string | null;
}

/**
 * Move, resize or rename one appointment.
 *
 * This is what dragging a block on the grid comes down to. Null when the id is not this
 * organisation's or is not there; `SlotTaken` when the move lands on a minute another live
 * booking already starts on, which is the same index `bookSlot` answers to and the same
 * refusal — so a dragged block and a booked slot cannot disagree about what is free.
 *
 * A cancelled booking is left alone: it holds no time, and moving it would resurrect it
 * without saying so. Cancel-and-rebook is the honest way back from a cancellation.
 */
export const rescheduleBooking = async (
  scope: OrganizationScope,
  bookingId: string,
  edit: BookingEdit,
): Promise<Booking | null> => {
  await scope.query("savepoint reschedule_booking");
  let rows: Record<string, unknown>[];
  try {
    rows = await scope.mutate<Record<string, unknown>>(
      `update appointment_bookings
          set starts_at = coalesce($2, starts_at),
              ends_at   = coalesce($3, ends_at),
              title     = case when $4 then $5 else title end,
              notes     = case when $6 then $7 else notes end,
              contact_id = case when $8 then $9 else contact_id end
        where id = $1
          and status <> 'cancelled'
        returning ${BOOKING_COLUMNS}`,
      [
        bookingId,
        edit.startsAt ?? null,
        edit.endsAt ?? null,
        edit.title !== undefined,
        edit.title?.trim() || null,
        edit.notes !== undefined,
        edit.notes?.trim() || null,
        edit.contactId !== undefined,
        edit.contactId ?? null,
      ],
    );
  } catch (error: unknown) {
    await scope.query("rollback to savepoint reschedule_booking");
    if (
      codeOf(error) === UNIQUE_VIOLATION &&
      constraintOf(error) === "appointment_bookings_one_per_slot_idx"
    ) {
      throw new SlotTaken("", edit.startsAt ?? new Date(0));
    }
    throw error;
  }
  await scope.query("release savepoint reschedule_booking");

  const row = rows[0];
  return row === undefined ? null : asBooking(row);
};

export const confirmHold = async (
  scope: OrganizationScope,
  bookingId: string,
  now: Date,
): Promise<boolean> => {
  const rows = await scope.mutate<Record<string, unknown>>(
    `update appointment_bookings
        set status = 'booked', hold_expires_at = null
      where id = $1 and status = 'held' and hold_expires_at > $2
      returning id`,
    [bookingId, now],
  );
  return rows.length > 0;
};

export const cancelBooking = async (
  scope: OrganizationScope,
  bookingId: string,
): Promise<boolean> => {
  const rows = await scope.mutate<Record<string, unknown>>(
    `update appointment_bookings
        set status = 'cancelled'
      where id = $1 and status <> 'cancelled'
      returning id`,
    [bookingId],
  );
  return rows.length > 0;
};


