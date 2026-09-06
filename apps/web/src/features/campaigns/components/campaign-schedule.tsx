"use client";

import { startTransition, useActionState, useState } from "react";

import { Button, CONTROL, Field, Notice, Stack } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { setScheduleAction, type ScheduleState } from "../campaigns.actions";

const START: ScheduleState = idleForm();

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * A local wall-clock reading of an instant, in the shape the inputs want.
 *
 * `toISOString` would be the wrong half of the problem: it renders UTC, so an 09:00 start in
 * Lagos comes back as 08:00 and the operator is shown a time they did not set. These read the
 * browser's own zone, which is the zone the person picking the time is standing in.
 */
const parts = (iso: string | null): { readonly date: string; readonly time: string } => {
  if (iso === null) return { date: "", time: "" };
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { date: "", time: "" };
  return {
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  };
};

/** Both halves, or nothing. A date without a time would silently mean midnight. */
const instant = (date: string, time: string): string | null =>
  date === "" || time === "" ? null : new Date(`${date}T${time}`).toISOString();

const When = ({
  legend,
  hint,
  date,
  time,
  disabled,
  onDate,
  onTime,
}: {
  readonly legend: string;
  readonly hint: string;
  readonly date: string;
  readonly time: string;
  readonly disabled: boolean;
  readonly onDate: (value: string) => void;
  readonly onTime: (value: string) => void;
}) => (
  <fieldset>
    <legend className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-[var(--ink-3)] uppercase">
      {legend}
    </legend>
    <div className="flex flex-wrap gap-2">
      <Field label="Date" className="min-w-[8.5rem] flex-[2]">
        <input
          type="date"
          value={date}
          disabled={disabled}
          onChange={(event) => onDate(event.target.value)}
          className={CONTROL}
        />
      </Field>
      <Field label="Time" className="min-w-[6.5rem] flex-1">
        <input
          type="time"
          value={time}
          disabled={disabled}
          onChange={(event) => onTime(event.target.value)}
          className={CONTROL}
        />
      </Field>
    </div>
    <p className="mt-1 text-[11.5px] text-[var(--ink-3)]">{hint}</p>
  </fieldset>
);

/**
 * The span a campaign runs over: when it starts, and when it gives up.
 *
 * Both ends carry a time rather than just a date, because both decisions are made to the
 * hour — "Tuesday first thing" and "stop before the weekend" are different from Tuesday and
 * Friday, and a date alone would silently mean midnight at each end.
 *
 * This is not the calling window and must not read as it. The window is a recurring shape —
 * these hours, these weekdays, every week — and lives beside this as a drawing. This is a
 * single span with two ends. The two were in one card and the card looked like a pile;
 * separating them by what kind of thing they are is what makes either legible.
 *
 * The two ends are not equally editable, which is deliberate rather than an oversight. A
 * start is meaningless once a campaign has started and the API refuses it, so the control
 * goes away. An end stays live for the whole run: "stop this by Friday" is an ordinary thing
 * to decide about a campaign already dialling, and without it pausing by hand is the only way
 * to end one.
 */
export const CampaignSchedule = ({
  campaignId,
  startsAt,
  endsAt,
  startEditable,
  canWrite,
}: {
  readonly campaignId: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  /** False once the campaign has started. The end stays editable regardless. */
  readonly startEditable: boolean;
  readonly canWrite: boolean;
}) => {
  const [state, action, pending] = useActionState(setScheduleAction, START);
  const [from, setFrom] = useState(parts(startsAt));
  const [to, setTo] = useState(parts(endsAt));

  const locked = !canWrite || pending;
  const begins = instant(from.date, from.time);
  const finishes = instant(to.date, to.time);

  const halfStart = (from.date === "") !== (from.time === "");
  const halfEnd = (to.date === "") !== (to.time === "");
  const backwards =
    begins !== null && finishes !== null && new Date(finishes) <= new Date(begins);

  const save = (): void => {
    const form = new FormData();
    form.set("campaignId", campaignId);
    if (begins !== null) form.set("startsAt", begins);
    if (finishes !== null) form.set("endsAt", finishes);
    startTransition(() => action(form));
  };

  const clear = (): void => {
    setFrom({ date: "", time: "" });
    setTo({ date: "", time: "" });
    const form = new FormData();
    form.set("campaignId", campaignId);
    startTransition(() => action(form));
  };

  return (
    <Stack gap="sm">
      {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}
      {state.status === "succeeded" && state.data !== null && (
        <Notice tone="ok">
          {state.data.startsAt === null && state.data.endsAt === null
            ? "Cleared. It starts when you start it and runs until the list is done."
            : "Saved."}
        </Notice>
      )}

      {startEditable ? (
        <When
          legend="Starts"
          hint="It moves to running on its own at this moment."
          date={from.date}
          time={from.time}
          disabled={locked}
          onDate={(date) => setFrom((one) => ({ ...one, date }))}
          onTime={(time) => setFrom((one) => ({ ...one, time }))}
        />
      ) : (
        <p className="text-[12px] leading-relaxed text-[var(--ink-3)]">
          {startsAt === null
            ? "Started by hand."
            : `Started at ${new Date(startsAt).toLocaleString()}.`}
        </p>
      )}

      <When
        legend="Stops"
        hint="Whatever is left on the list is dropped. A call already in progress finishes."
        date={to.date}
        time={to.time}
        disabled={locked}
        onDate={(date) => setTo((one) => ({ ...one, date }))}
        onTime={(time) => setTo((one) => ({ ...one, time }))}
      />

      {(halfStart || halfEnd) && (
        <p className="text-[11.5px] text-[var(--ink-3)]">
          A date needs a time beside it, or it would mean midnight.
        </p>
      )}
      {backwards && (
        <Notice tone="warn">
          The stop has to be after the start, or the campaign would finish on the same sweep it
          began.
        </Notice>
      )}

      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={locked || backwards || halfStart || halfEnd}
            onClick={save}
          >
            {pending ? "Saving…" : "Save schedule"}
          </Button>
          {(startsAt !== null || endsAt !== null) && (
            <Button size="sm" disabled={locked} onClick={clear}>
              Clear
            </Button>
          )}
        </div>
      )}
    </Stack>
  );
};
