"use client";

import { useActionState } from "react";

import { Card, ChoiceChips, minutesLabel, Notice, Row, SubmitButton, Tag, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast, useFailureToast } from "@/stores/toast.store";

import { editCalendarAction, type CalendarState } from "../appointments.actions";
import type { CalendarSummary } from "../appointments.service";
import { TimezoneSelect } from "./timezone-select";

const START: CalendarState = idleForm();

/**
 * The calendar's own settings.
 *
 * Keyed on the calendar so switching to another one remounts the fields onto that calendar's
 * values rather than leaving the previous one's text in uncontrolled inputs — the same reset
 * rule every form in this console follows.
 *
 * A connector's external reference is shown but not editable: it names the outside diary this
 * calendar mirrors, and changing it here would point Ansa at a different diary while the
 * bookings stayed, which is never what an edit means. The name, zone, slot and buffer are the
 * calendar's own and stay editable for both kinds.
 */
export const EditCalendarPanel = ({
  calendar,
  canWrite,
}: {
  readonly calendar: CalendarSummary;
  readonly canWrite: boolean;
}) => {
  const [state, action, pending] = useActionState(editCalendarAction, START);
  useFailureToast(state);
  useFormToast(state, () => "Settings saved.");

  const fieldError = (name: string): string | undefined => state.fieldErrors[name];

  return (
    <Card
      title="Calendar settings"
      description="The name, timezone, slot length and buffer. The timezone is what the hours and every booking are read in."
    >
      {calendar.source === "connector" && (
        <Notice tone="info" className="mb-4">
          This is a connector calendar. It mirrors an outside diary
          {calendar.externalRef !== null ? (
            <>
              {" "}
              (<span className="font-mono">{calendar.externalRef}</span>)
            </>
          ) : null}
          . Its hours and bookings are read here; the outside diary remains the source.
        </Notice>
      )}

      <form key={calendar.id} action={action} className="flex flex-col gap-3.5">
        <input type="hidden" name="calendarId" value={calendar.id} />


        <Row className="items-center gap-2">
          <Tag tone={calendar.source === "connector" ? "accent" : "neutral"}>{calendar.source}</Tag>
          {calendar.externalRef !== null && (
            <span className="font-mono text-[12px] text-[var(--ink-3)]">{calendar.externalRef}</span>
          )}
        </Row>

        <TextField
          label="Name"
          name="name"
          required
          defaultValue={calendar.name}
          error={fieldError("name")}
          disabled={!canWrite}
          autoComplete="off"
        />

        <TimezoneSelect defaultValue={calendar.timezone} error={fieldError("timezone")} disabled={!canWrite} />

        <div className="flex flex-col gap-4">
            <ChoiceChips
              label="Slot length"
              name="slotMinutes"
              presets={[10, 15, 20, 30, 45, 60, 90]}
              format={minutesLabel}
              defaultValue={calendar.slotMinutes}
              error={fieldError("slotMinutes")}
              disabled={!canWrite}
              hint="Per appointment."
            />
            <ChoiceChips
              label="Buffer"
              name="bufferMinutes"
              presets={[0, 5, 10, 15, 30]}
              format={(minutes) => (minutes === 0 ? "None" : minutesLabel(minutes))}
              defaultValue={calendar.bufferMinutes}
              error={fieldError("bufferMinutes")}
              disabled={!canWrite}
              hint="Kept free either side of each appointment."
            />
          </div>

        {canWrite ? (
          <div>
            <SubmitButton pending={pending} idle="Save settings" />
          </div>
        ) : (
          <Notice tone="info">You can view these settings. Changing them needs the appointments:write permission.</Notice>
        )}
      </form>
    </Card>
  );
};
