import type { Metadata } from "next";

import { EmptyState, Notice, PageHeader, Panel, Tabs, type TabDef } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import {
  listBookings,
  listCalendars,
  listSlots,
  readAvailability,
  type CalendarSummary,
} from "@/features/appointments/appointments.service";
import { AvailabilityEditor } from "@/features/appointments/components/availability-editor";
import { CalendarSwitcher } from "@/features/appointments/components/calendar-switcher";
import { CreateCalendarDialog } from "@/features/appointments/components/create-calendar-dialog";
import { EditCalendarPanel } from "@/features/appointments/components/edit-calendar-panel";
import { CalendarBoard } from "@/features/appointments/components/calendar-view";
import { CalendarNav } from "@/features/appointments/components/calendar-nav";
import {
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
};

const AppointmentsPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<AppointmentsSearch>;
}) => {
  const search = await searchParams;
  const [principal, { items: calendars }] = await Promise.all([
    currentPrincipal(),
    listCalendars(),
  ]);
  const canWrite = principal.capabilities.includes("appointments:write");

  if (calendars.length === 0) {
    return (
      <>
        <PageHeader
          eyebrow="Operate"
          title="Appointments"
          meta="Calendars, their open hours, and the appointments written against them — including the slots the agent offers on a call."
          actions={canWrite ? <CreateCalendarDialog /> : undefined}
        />
        <Panel>
          <EmptyState
            title="No calendars yet"
            action={canWrite ? <CreateCalendarDialog /> : undefined}
          >
            A calendar has a timezone, a slot length and a buffer. Create one and you can write
            appointments into it straight away; set its weekly hours and those same times become
            the free slots the agent offers on a call.
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
  const [availability, slots, bookings] = await Promise.all([
    readAvailability(selected.id),
    drawsSlots
      ? listSlots(selected.id, range.from, range.to)
      : Promise.resolve({ slots: [] as Awaited<ReturnType<typeof listSlots>>["slots"] }),
    listBookings(selected.id, range.from, range.to),
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

  const tabs: readonly TabDef[] = [
    {
      id: "calendar",
      label: "Calendar",
      panel: (
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
              This calendar has no open hours yet, so the agent offers no slots on a call. You can
              still write appointments into it here. Set its weekly hours on the Weekly hours tab
              to have the agent offer them.
            </Notice>
          ) : (
            selected.source === "connector" && (
              <Notice tone="info">
                This is a connector calendar, mirroring an outside diary. Its slots and
                appointments are shown here and can be written against; the diary remains the
                source of truth.
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
          />
        </div>
      ),
    },
    {
      id: "hours",
      label: "Weekly hours",
      panel: (
        <AvailabilityEditor
          key={selected.id}
          calendarId={selected.id}
          windows={availability.windows}
          canWrite={canWrite}
        />
      ),
    },
    {
      id: "settings",
      label: "Settings",
      panel: <EditCalendarPanel key={selected.id} calendar={selected} canWrite={canWrite} />,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Appointments"
        meta="One calendar's diary, in its own timezone. Drag on any empty time to write an appointment; the tinted hours are the ones the agent offers on a call."
        actions={
          <div className="flex items-center gap-2">
            <CalendarSwitcher calendars={calendars} selectedId={selected.id} />
            {canWrite && <CreateCalendarDialog trigger="secondary" />}
          </div>
        }
      />

      <Tabs tabs={tabs} />
    </>
  );
};

export default AppointmentsPage;
