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
import { WeekGrid, type DayColumn } from "@/features/appointments/components/week-grid";
import type { BookingView } from "@/features/appointments/components/booking-details";
import { WeekNav } from "@/features/appointments/components/week-nav";
import {
  groupBookingsByDay,
  groupSlotsByDay,
  dayWindow,
  isoDate,
  parseIsoDate,
  todayIn,
  weekDays,
  weekRange,
  type PlainDate,
} from "@/features/appointments/appointments.time";

export const metadata: Metadata = { title: "Appointments · Ansa" };
export const dynamic = "force-dynamic";

/**
 * The appointments workspace.
 *
 * One page over one calendar at a time: which calendar and which week both live in the URL
 * (`?calendar=&week=`), so a view is a link and the back button behaves, exactly like the
 * calls filter and the contacts search. Everything below is read for that calendar in *its*
 * timezone — the reader's zone never enters into it — which is the whole reason a booking made
 * here is never ambiguous about when it is.
 *
 * The three tabs are the three things an operator does with a calendar: look at the week and
 * book into it, set the recurring hours it opens on, and edit the calendar itself. They are
 * one entity's views, not navigation, which is what `Tabs` is for.
 */
type AppointmentsSearch = {
  readonly calendar?: string;
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
          meta="Calendars, their open hours, and the bookings taken against them — the same slots the agent offers on a call."
          actions={canWrite ? <CreateCalendarDialog /> : undefined}
        />
        <Panel>
          <EmptyState
            title="No calendars yet"
            action={canWrite ? <CreateCalendarDialog /> : undefined}
          >
            A calendar has a timezone, a slot length and a buffer. Create one, set its weekly
            hours, and its free slots appear here for booking — and for the agent to offer.
            {!canWrite && " Creating one needs the appointments:write permission."}
          </EmptyState>
        </Panel>
      </>
    );
  }

  const selected: CalendarSummary =
    calendars.find((calendar) => calendar.id === search.calendar) ?? calendars[0]!;

  const anchor: PlainDate = parseIsoDate(search.week) ?? todayIn(selected.timezone);
  const { from, to } = weekRange(anchor, selected.timezone);

  const [availability, slots, bookings] = await Promise.all([
    readAvailability(selected.id),
    listSlots(selected.id, from, to),
    listBookings(selected.id, from, to),
  ]);

  const days = weekDays(anchor);
  const todayIso = isoDate(todayIn(selected.timezone));
  const slotsByDay = groupSlotsByDay(slots.slots, days, selected.timezone);
  const bookingsByDay = groupBookingsByDay(bookings.items, days, selected.timezone);

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

  const columns: DayColumn[] = days.map((day) => {
    const daySlots = slotsByDay.get(day.iso) ?? [];
    const dayBookings = bookingsByDay.get(day.iso) ?? [];
    return {
      iso: day.iso,
      weekday: day.weekday,
      shortLabel: day.shortLabel,
      dayNumber: day.date.day,
      isToday: day.iso === todayIso,
      slots: daySlots.map((slot) => ({
        start: slot.start,
        end: slot.end,
        startMinute: slot.startMinute,
        endMinute: slot.endMinute,
        label: slot.label,
      })),
      bookings: dayBookings.map(({ booking, startMinute, endMinute }): BookingView => ({
        id: booking.id,
        status: booking.status === "held" ? "held" : "booked",
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
        startMinute,
        endMinute,
        contactId: booking.contactId,
        notes: booking.notes,
        holdExpiresAt: booking.holdExpiresAt,
        source: booking.source,
      })),
    };
  });

  const noAvailability = availability.windows.length === 0;

  const tabs: readonly TabDef[] = [
    {
      id: "calendar",
      label: "Calendar",
      panel: (
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <WeekNav calendarId={selected.id} anchor={anchor} timeZone={selected.timezone} />
            <div className="text-[12px] text-[var(--ink-3)]">
              Times shown in <span className="font-medium text-[var(--ink-2)]">{selected.timezone}</span>
            </div>
          </div>

          {noAvailability ? (
            <Notice tone="warn">
              This calendar has no open hours yet, so it offers no slots. Set its weekly hours on
              the Weekly hours tab, then bookings can be taken here.
            </Notice>
          ) : (
            selected.source === "connector" && (
              <Notice tone="info">
                This is a connector calendar, mirroring an outside diary. Its slots and bookings
                are shown here and can be booked against; the diary remains the source of truth.
              </Notice>
            )
          )}

          <WeekGrid
            calendarId={selected.id}
            days={columns}
            startMinute={dayBounds.startMinute}
            endMinute={dayBounds.endMinute}
            timeZone={selected.timezone}
            canWrite={canWrite}
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
        meta="The week for one calendar, in its own timezone. Free slots are the ones the agent offers on a call; book, hold, confirm and cancel them here."
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
