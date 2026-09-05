"use client";

import { useState } from "react";
import { CalendarOff, Clock, Settings2 } from "lucide-react";

import { Button, Modal } from "@/components/ui";

import type { AvailabilityWindows, CalendarSummary, Holiday } from "../appointments.service";
import { AvailabilityEditor } from "./availability-editor";
import { EditCalendarPanel } from "./edit-calendar-panel";
import { HolidaysEditor } from "./holidays-editor";

/**
 * The two things you set up once, kept out of the way of the thing you do every day.
 *
 * These were tabs beside the calendar, which made the calendar one of three things the page
 * might be showing. It is not — it is what the page *is*, and the weekly hours and the
 * calendar's own settings are occasional work that should not cost the diary its place on
 * screen. So they open over it and hand it straight back.
 */
export const CalendarSettings = ({
  calendar,
  windows,
  holidays,
  canWrite,
}: {
  readonly calendar: CalendarSummary;
  readonly windows: AvailabilityWindows;
  readonly holidays: readonly Holiday[];
  readonly canWrite: boolean;
}) => {
  const [open, setOpen] = useState<"hours" | "closures" | "settings" | null>(null);

  return (
    <>
      <Button size="sm" onClick={() => setOpen("hours")}>
        <Clock aria-hidden className="size-3.5" />
        Weekly hours
      </Button>
      <Button size="sm" onClick={() => setOpen("closures")}>
        <CalendarOff aria-hidden className="size-3.5" />
        Closures
      </Button>
      <Button size="sm" onClick={() => setOpen("settings")}>
        <Settings2 aria-hidden className="size-3.5" />
        Settings
      </Button>

      <Modal
        open={open === "hours"}
        onClose={() => setOpen(null)}
        title="Weekly hours"
        description={`The hours ${calendar.name} opens on, read in ${calendar.timezone}. These decide which times count as free.`}
      >
        <AvailabilityEditor
          key={calendar.id}
          calendarId={calendar.id}
          windows={windows}
          canWrite={canWrite}
        />
      </Modal>

      <Modal
        open={open === "closures"}
        onClose={() => setOpen(null)}
        title="Days the office is shut"
        description="Organisation-wide. No calendar offers a caller a slot on one of these days."
      >
        <HolidaysEditor holidays={holidays} canWrite={canWrite} />
      </Modal>

      <Modal
        open={open === "settings"}
        onClose={() => setOpen(null)}
        title="Calendar settings"
        description={`Name, timezone, slot length and buffer for ${calendar.name}.`}
      >
        <EditCalendarPanel key={calendar.id} calendar={calendar} canWrite={canWrite} />
      </Modal>
    </>
  );
};
