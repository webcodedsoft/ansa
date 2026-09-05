import type { Metadata } from "next";

import { EmptyState, Notice, PageHeader, Panel } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import {
  ensureCalendar,
  listBookings,
  listCalendars,
  listHolidays,
  listSlots,
  readAvailability,
  searchBookings,
  type CalendarSummary,
} from "@/features/appointments/appointments.service";
import { CalendarSwitcher } from "@/features/appointments/components/calendar-switcher";
import { CreateCalendarDialog } from "@/features/appointments/components/create-calendar-dialog";
import { CalendarSettings } from "@/features/appointments/components/calendar-settings";
import { AppointmentSearch } from "@/features/appointments/components/appointment-search";
import {
  SearchResults,
  type SearchHit,
} from "@/features/appointments/components/search-results";
import { CalendarBoard } from "@/features/appointments/components/calendar-view";
import { CalendarNav } from "@/features/appointments/components/calendar-nav";
import {
  bookingLabel,
  calendarRange,
  parseView,
  parseWeekends,
} from "@/features/appointments/appointments.range";
import { CalendarKeys } from "@/features/appointments/components/calendar-keys";
import { MiniMonth } from "@/features/appointments/components/mini-month";
import type {
  BookingView,
  DayColumn,
  MonthCell,
} from "@/features/appointments/appointments.view";
import {
  groupBookingsByDay,
  groupSlotsByDay,
  dayWindow,
  isoDate,
  parseIsoDate,
  zonedParts,
  bookingWhen,
  todayIn,
  type PlainDate,
} from "@/features/appointments/appointments.time";

export const metadata: Metadata = { title: "Appointments · Ansa" };
export const dynamic = "force-dynamic";

/**
 * The appointments workspace.
 *
 * One page over one calendar at a time: which calendar, which view and which day all live in
 * the URL (`?calendar=&view=&date=`), so a view is a link and the back button behaves, exactly
 * like the calls filter and the contacts search. Everything below is read for that calendar in
 * *its* timezone — the reader's zone never enters into it — which is the whole reason an
 * appointment made here is never ambiguous about when it is.
 *
 * The three tabs are the three things an operator does with a calendar: look at the diary and
 * write in it, set the recurring hours it opens on, and edit the calendar itself. They are one
 * entity's views, not navigation, which is what `Tabs` is for.
 */
type AppointmentsSearch = {
  readonly calendar?: string;
  readonly view?: string;
  readonly date?: string;
  /** `0` hides Saturday and Sunday from the grid views. Absent means shown. */
  readonly weekends?: string;
  /** The old name for `date`, from when the page only had a week view. Still honoured. */
  readonly week?: string;
  /** A search term. When present the page answers the search instead of drawing the week. */
  readonly q?: string;
};

const AppointmentsPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<AppointmentsSearch>;
}) => {
  const search = await searchParams;
  const [principal, listed] = await Promise.all([currentPrincipal(), listCalendars()]);
  const canWrite = principal.capabilities.includes("appointments:write");

  /* An organisation always has a calendar. Opening this screen on "no calendars yet" and a
     button is the wrong first thing to show somebody who came to look at a diary, and it is
     not what any calendar worth copying does. Provisioned on the first visit by somebody who
     could have made one by hand anyway; a reader without that permission still sees the empty
     state, which is the honest answer for them. */
  const calendars =
    listed.items.length === 0 && canWrite
      ? await ensureCalendar()
          .then((made) => [made])
          .catch(() => listed.items)
      : listed.items;

  if (calendars.length === 0) {
    return (
      <>
        <PageHeader
          eyebrow="Operate"
          title="Appointments"
          meta="Calendars, their open hours, and the appointments written against them."
          actions={canWrite ? <CreateCalendarDialog /> : undefined}
        />
        <Panel>
          <EmptyState
            title="No calendars yet"
            action={canWrite ? <CreateCalendarDialog /> : undefined}
          >
            A calendar has a timezone, a slot length and a buffer. Create one and you can write
            appointments into it straight away; set its weekly hours and those same times become
            free slots, which the agent will offer on a call once it can book.
            {!canWrite && " Creating one needs the appointments:write permission."}
          </EmptyState>
        </Panel>
      </>
    );
  }

  const selected: CalendarSummary =
    calendars.find((calendar) => calendar.id === search.calendar) ?? calendars[0]!;

  const view = parseView(search.view);
  const showWeekends = parseWeekends(search.weekends);
  const today = todayIn(selected.timezone);
  const anchor: PlainDate =
    parseIsoDate(search.date) ?? parseIsoDate(search.week) ?? today;
  const range = calendarRange(view, anchor, selected.timezone, { today, showWeekends });

  /* Only the time grids place free slots by the minute. A month is a list per day and the
     schedule has no clock at all, so asking for six weeks of slots would be a large query
     thrown away on arrival. */
  const drawsSlots = view === "day" || view === "week";
  const [availability, slots, bookings, holidays] = await Promise.all([
    readAvailability(selected.id),
    drawsSlots
      ? listSlots(selected.id, range.from, range.to)
      : Promise.resolve({ slots: [] as Awaited<ReturnType<typeof listSlots>>["slots"] }),
    listBookings(selected.id, range.from, range.to),
    listHolidays(),
  ]);

  const slotsByDay = groupSlotsByDay(slots.slots, range.days, selected.timezone);
  const bookingsByDay = groupBookingsByDay(bookings.items, range.days, selected.timezone);

  /* The vertical window the grid draws: the open hours, widened to hold anything booked or
     offered outside them, so a calendar's real day is on screen without a silent empty cliff. */
  const availabilityMinutes = availability.windows.map((window) => ({
    startMinute: window.startMinute,
    endMinute: window.endMinute,
  }));
  const occupiedMinutes = [
    ...[...slotsByDay.values()].flat(),
    ...[...bookingsByDay.values()].flat(),
  ].map((placed) => ({ startMinute: placed.startMinute, endMinute: placed.endMinute }));
  const dayBounds = dayWindow(availabilityMinutes, occupiedMinutes);

  const bookingsOn = (iso: string): readonly BookingView[] =>
    (bookingsByDay.get(iso) ?? []).map(({ booking, startMinute, endMinute }): BookingView => ({
      id: booking.id,
      status: booking.status === "held" ? "held" : "booked",
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      startMinute,
      endMinute,
      contactId: booking.contactId,
      title: booking.title,
      notes: booking.notes,
      holdExpiresAt: booking.holdExpiresAt,
      source: booking.source,
    }));

  const days: readonly DayColumn[] = range.days.map((day) => ({
    iso: day.iso,
    weekday: day.weekday,
    shortLabel: day.shortLabel,
    dayNumber: day.dayNumber,
    isToday: day.isToday,
    slots: (slotsByDay.get(day.iso) ?? []).map((slot) => ({
      start: slot.start,
      end: slot.end,
      startMinute: slot.startMinute,
      endMinute: slot.endMinute,
      label: slot.label,
    })),
    bookings: bookingsOn(day.iso),
  }));

  const cells: readonly (readonly MonthCell[])[] = range.weeks.map((week) =>
    week.map((day) => ({
      iso: day.iso,
      dayNumber: day.dayNumber,
      shortLabel: day.shortLabel,
      inMonth: day.inPeriod,
      isToday: day.isToday,
      bookings: bookingsOn(day.iso),
    })),
  );

  const noAvailability = availability.windows.length === 0;

  const calendarBody = (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CalendarNav
          calendarId={selected.id}
          view={view}
          anchor={anchor}
          timeZone={selected.timezone}
          showWeekends={showWeekends}
        />
        <div className="text-[12px] text-[var(--ink-3)]">
          Times shown in{" "}
          <span className="font-medium text-[var(--ink-2)]">{selected.timezone}</span>
        </div>
      </div>

      {noAvailability ? (
        <Notice tone="info">
          This calendar has no open hours yet, so it computes no free slots. You can still
          write appointments into it here; set its weekly hours to have it work out the times
          that are free.
        </Notice>
      ) : (
        selected.source === "connector" && (
          <Notice tone="info">
            This is a connector calendar, mirroring an outside diary. Its slots and appointments
            are shown here and can be written against; the diary remains the source of truth.
          </Notice>
        )
      )}

      {/* The little month sits beside the grid on a wide screen and above it on a narrow
          one, where a sidebar would push the calendar off the edge. */}
      <div className="flex flex-col gap-3.5 lg:grid lg:grid-cols-[196px_minmax(0,1fr)] lg:items-start">
        <MiniMonth
          calendarId={selected.id}
          view={view}
          anchor={anchor}
          timeZone={selected.timezone}
          todayIso={isoDate(today)}
          showWeekends={showWeekends}
        />

        <CalendarBoard
          key={`${selected.id}:${view}`}
          calendarId={selected.id}
          view={view}
          days={days}
          cells={cells}
          startMinute={dayBounds.startMinute}
          endMinute={dayBounds.endMinute}
          timeZone={selected.timezone}
          slotMinutes={selected.slotMinutes}
          hasHours={!noAvailability}
          canWrite={canWrite}
        />
      </div>

      <CalendarKeys
        calendarId={selected.id}
        view={view}
        anchor={anchor}
        timeZone={selected.timezone}
        showWeekends={showWeekends}
      />
    </div>
  );

  /* A search answers a different question from the grid — "where is the Adeola viewing",
     not "what is on this week" — so it replaces the calendar rather than filtering it. A
     match three months out would need three months of grid drawn around it to be seen. */
  const term = search.q?.trim() ?? "";
  const found = term.length >= 2 ? await searchBookings(term) : null;
  const byId = new Map(calendars.map((one) => [one.id, one]));
  const hits: readonly SearchHit[] =
    found === null
      ? []
      : found.items.flatMap((booking): SearchHit[] => {
          const owner = byId.get(booking.calendarId);
          if (owner === undefined) return [];
          /* The API already excludes cancelled ones; this narrows the type the grid shares,
             which has no `cancelled` because a cancelled appointment is never drawn. */
          if (booking.status !== "held" && booking.status !== "booked") return [];
          const status = booking.status;
          const day = zonedParts(new Date(booking.startsAt), owner.timezone);
          const iso = isoDate({ year: day.year, month: day.month, day: day.day });
          return [
            {
              id: booking.id,
              label: bookingLabel({ ...booking, status }),
              /* Read in the owning calendar's zone, not the one on screen: two calendars may
                 keep different zones and a time in the wrong one is worse than none. */
              when: bookingWhen(booking.startsAt, owner.timezone),
              calendarName: owner.name,
              status,
              href: `/appointments?calendar=${encodeURIComponent(owner.id)}&view=day&date=${iso}`,
            },
          ];
        });

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Appointments"
        meta="One calendar's diary, in its own timezone. Drag on any empty time to write an appointment; the tinted hours are the ones its weekly hours leave free."
        actions={
          <div className="flex items-center gap-2">
            <CalendarSwitcher calendars={calendars} selectedId={selected.id} />
            <CalendarSettings
              calendar={selected}
              windows={availability.windows}
              holidays={holidays.items}
              canWrite={canWrite}
            />
            {canWrite && <CreateCalendarDialog trigger="secondary" />}
          </div>
        }
      />

      {/* Above both, because the box must not vanish at the moment it is being used — a
          search that hides its own input leaves nothing to correct a typo in. */}
      <div className="mb-3.5 flex justify-end">
        <AppointmentSearch calendarId={selected.id} query={term} />
      </div>

      {found !== null ? (
        <SearchResults
          query={term}
          hits={hits}
          clearHref={`/appointments?calendar=${encodeURIComponent(selected.id)}&view=${view}&date=${isoDate(anchor)}`}
        />
      ) : (
        calendarBody
      )}
    </>
  );
};

export default AppointmentsPage;
