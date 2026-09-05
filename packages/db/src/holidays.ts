import type { OrganizationScope } from "./organization-scope";

/**
 * Days the office is shut (0064).
 *
 * Organisation-wide rather than per calendar, one row per date, no recurrence rule — the
 * migration argues all three. This file only stores and returns them; deciding that a given
 * slot falls on one is arithmetic in the calendar's timezone, and that lives beside the
 * timezone library in `apps/api/src/api/appointments/slots.ts` for the same reason the slot
 * expansion does.
 *
 * **`on_date` is read and written as a `YYYY-MM-DD` string, never as a `Date`.** This is the
 * trap the column exists to avoid, reintroduced one layer up if you let it: node-postgres
 * parses a `date` into a JavaScript `Date` at *local* midnight, so a row saying
 * `2026-10-01` comes back as an instant that is the thirtieth of September in any zone west
 * of the server. Rendering with `to_char` in the query keeps the calendar square a calendar
 * square all the way to the caller, and there is then no instant anywhere to be wrong.
 */

/** A date the organisation's office is shut. `onDate` is `YYYY-MM-DD`, with no hour on it. */
export interface Holiday {
  readonly id: string;
  /** The calendar date, `YYYY-MM-DD`. Judged in the calendar's timezone by whoever uses it. */
  readonly onDate: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/* `to_char` rather than the bare column: see the header. The driver would hand back a `Date`
   at local midnight and the date would move by a day for half the world. */
const HOLIDAY_COLUMNS =
  "id, to_char(on_date, 'YYYY-MM-DD') as on_date, name, created_at, updated_at";

const asHoliday = (row: Record<string, unknown>): Holiday => ({
  id: String(row["id"]),
  onDate: String(row["on_date"]),
  name: String(row["name"]),
  createdAt: new Date(String(row["created_at"])),
  updatedAt: new Date(String(row["updated_at"])),
});

/** An inclusive span of calendar dates, both `YYYY-MM-DD`. */
export interface HolidayRange {
  readonly from: string;
  readonly to: string;
}

/**
 * The organisation's holidays, oldest date first.
 *
 * With a range, only the dates inside it, both ends included — a range is a span of squares
 * on a calendar and the last square is one of them, which is the opposite of the half-open
 * instant ranges the bookings queries take. A slot lookup asks for exactly the days it is
 * about to expand; a console listing a year asks for that year.
 */
export const readHolidays = async (
  scope: OrganizationScope,
  range?: HolidayRange,
): Promise<readonly Holiday[]> => {
  const rows =
    range === undefined
      ? await scope.query<Record<string, unknown>>(
          `select ${HOLIDAY_COLUMNS} from holidays order by on_date, id`,
        )
      : await scope.query<Record<string, unknown>>(
          `select ${HOLIDAY_COLUMNS}
             from holidays
            where on_date between $1::date and $2::date
            order by on_date, id`,
          [range.from, range.to],
        );
  return rows.map(asHoliday);
};

export interface NewHoliday {
  /** `YYYY-MM-DD`. */
  readonly onDate: string;
  readonly name: string;
}

/**
 * Mark a date shut, or learn that it already is.
 *
 * Null means the organisation already keeps that date — `holidays_organization_date_idx`
 * refused it. Returned rather than thrown because it is not an error in the database's
 * sense and it must not abort the caller's transaction: `on conflict do nothing` leaves the
 * transaction usable, where a raised unique violation would need the savepoint dance
 * `bookSlot` has to do. The insert cannot fail to find a row for any other reason, so no
 * row means exactly one thing.
 *
 * The organisation is `app.current_organization()`, not a parameter, so the value the policy
 * checks is the only value that can be written.
 */
export const addHoliday = async (
  scope: OrganizationScope,
  input: NewHoliday,
): Promise<Holiday | null> => {
  const rows = await scope.query<Record<string, unknown>>(
    `insert into holidays (organization_id, on_date, name)
     values (app.current_organization(), $1::date, $2)
     on conflict (organization_id, on_date) do nothing
     returning ${HOLIDAY_COLUMNS}`,
    [input.onDate, input.name.trim()],
  );
  const row = rows[0];
  return row === undefined ? null : asHoliday(row);
};

/**
 * The office is open that day after all.
 *
 * Hard deleted rather than soft: a holiday is a statement about the future, and a "deleted"
 * one that still suppressed slots would be the exact failure 0032 warns about. False when
 * the id is not this organisation's, which under RLS is also what somebody else's holiday
 * looks like.
 *
 * `scope.mutate`, not `scope.query`: a `delete … returning` comes back as
 * `[rows, affectedCount]` and `.length > 0` on that is always true.
 */
export const removeHoliday = async (
  scope: OrganizationScope,
  holidayId: string,
): Promise<boolean> => {
  const rows = await scope.mutate<Record<string, unknown>>(
    `delete from holidays where id = $1 returning id`,
    [holidayId],
  );
  return rows.length > 0;
};
