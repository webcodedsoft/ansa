"use client";

import { startTransition, useActionState, useState } from "react";

import { Button, CONTROL, Field, Notice, Stack } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { setScheduleAction, type ScheduleState } from "../campaigns.actions";

const START: ScheduleState = idleForm();

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * A local wall-clock reading of an instant, in the shape the two inputs want.
 *
 * `toISOString` would be the wrong half of the problem: it renders UTC, so an 09:00 start in
 * Lagos comes back as 08:00 and the operator is shown a time they did not set. These read the
 * browser's own zone, which is the zone the person picking the time is standing in.
 */
const dateValue = (iso: string | null): string => {
  if (iso === null) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

const timeValue = (iso: string | null): string => {
  if (iso === null) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
};

/**
 * When a campaign starts itself.
 *
 * `scheduled` was a status that did not mean what its name said: it meant "waiting for
 * somebody to press Start". A campaign for Tuesday morning had to be started on Tuesday
 * morning by a person who remembered. This is the missing half — pick a date and a time and
 * the sweeper starts it.
 *
 * Two inputs rather than one `datetime-local`, deliberately. The combined control renders
 * differently in every browser, cannot be styled to match anything else on this page, and has
 * its own keyboard behaviour. Two native inputs are two ordinary controls.
 *
 * They are read in the browser's own timezone and sent as an instant. Somebody in Lagos
 * picking 09:00 means 09:00 where they are standing, and converting here rather than on the
 * server is what makes that true — the server has no idea where they are.
 */
export const CampaignSchedule = ({
  campaignId,
  startsAt,
  editable,
  canWrite,
}: {
  readonly campaignId: string;
  readonly startsAt: string | null;
  /** False once the campaign has started; a start time would never be read after that. */
  readonly editable: boolean;
  readonly canWrite: boolean;
}) => {
  const [state, action, pending] = useActionState(setScheduleAction, START);
  const [date, setDate] = useState(dateValue(startsAt));
  const [time, setTime] = useState(timeValue(startsAt));

  const disabled = !editable || !canWrite || pending;
  const half = date !== "" && time === "";
  const chosen = date !== "" && time !== "";

  const submit = (clear: boolean): void => {
    const form = new FormData();
    form.set("campaignId", campaignId);
    if (!clear && chosen) {
      /* Built from the parts in local time and sent as an instant, so the server stores the
         moment rather than a string whose zone it would have to guess. */
      form.set("startsAt", new Date(`${date}T${time}`).toISOString());
    }
    startTransition(() => action(form));
  };

  if (!editable) {
    return (
      <p className="text-[12px] leading-relaxed text-[var(--ink-3)]">
        {startsAt === null
          ? "This campaign was started by hand."
          : `Started automatically at ${new Date(startsAt).toLocaleString()}.`}
      </p>
    );
  }

  return (
    <Stack gap="sm">
      {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}
      {state.status === "succeeded" && state.data !== null && (
        <Notice tone="ok">
          {state.data.startsAt === null
            ? "Cleared. This campaign waits for you to start it."
            : `Saved. It starts on its own at ${new Date(state.data.startsAt).toLocaleString()}.`}
        </Notice>
      )}

      <div className="flex flex-wrap gap-2.5">
        <Field label="Date" className="min-w-[9.5rem] flex-1">
          <input
            type="date"
            value={date}
            disabled={disabled}
            onChange={(event) => setDate(event.target.value)}
            className={CONTROL}
          />
        </Field>
        <Field label="Time" className="min-w-[7.5rem] flex-1">
          <input
            type="time"
            value={time}
            disabled={disabled}
            onChange={(event) => setTime(event.target.value)}
            className={CONTROL}
          />
        </Field>
      </div>

      {half && (
        <p className="text-[11.5px] text-[var(--ink-3)]">
          Pick a time as well — a date on its own would start it at midnight.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={disabled || !chosen}
          onClick={() => submit(false)}
        >
          {pending ? "Saving…" : "Schedule it"}
        </Button>
        {startsAt !== null && (
          <Button size="sm" disabled={disabled} onClick={() => submit(true)}>
            Start by hand instead
          </Button>
        )}
      </div>

      <p className="text-[11.5px] leading-relaxed text-[var(--ink-3)]">
        It moves to running on its own at that moment, then dials inside its calling window — a
        start time cannot buy an hour the window does not allow.
      </p>
    </Stack>
  );
};
