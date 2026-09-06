"use client";

import { startTransition, useActionState, useState } from "react";

import { Button, CONTROL, Field, Notice, Stack } from "@/components/ui";
import { cn } from "@/lib/cn";
import { idleForm } from "@/lib/form-state";

import { setScheduleAction, type ScheduleState } from "../campaigns.actions";
import type { CampaignWindow } from "../campaigns.service";
import {
  CUSTOM,
  offeredPresets,
  parts,
  presetFor,
  readable,
  STARTS,
  STOPS,
  type Parts,
  type Preset,
} from "../schedule-presets";

const START: ScheduleState = idleForm();

/** Both halves, or nothing. A date without a time would silently mean midnight. */
const instant = (date: string, time: string): string | null =>
  date === "" || time === "" ? null : new Date(`${date}T${time}`).toISOString();

const Chip = ({
  on,
  disabled,
  onClick,
  children,
}: {
  readonly on: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) => (
  <button
    type="button"
    role="radio"
    aria-checked={on}
    disabled={disabled}
    onClick={onClick}
    className={cn(
      "rounded-full border px-3 py-1.5 text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-55",
      on
        ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-on)]"
        : "border-[var(--hairline)] text-[var(--ink-2)] hover:border-[var(--ink-3)]",
    )}
  >
    {children}
  </button>
);

/**
 * One end of the run: a choice, with the exact pickers under "Pick a time".
 *
 * `none` is the honest default — started by hand, or run until the list is done — and it is
 * a chip like the others rather than an empty box that silently means it. The presets resolve
 * against the campaign's own hours, so "tomorrow" is tomorrow at the first hour it may ring.
 * A saved time that no preset produces lands on "Pick a time" with the fields filled, so the
 * card never shows a choice the row does not hold.
 */
const When = ({
  legend,
  hint,
  none,
  presets,
  value,
  now,
  window,
  disabled,
  onChange,
}: {
  readonly legend: string;
  readonly hint: string;
  readonly none: string;
  readonly presets: readonly Preset[];
  readonly value: Parts;
  readonly now: Date;
  readonly window: CampaignWindow | null;
  readonly disabled: boolean;
  readonly onChange: (next: Parts) => void;
}) => {
  const offered = offeredPresets(presets, now, window);
  const chosen = presetFor(value, offered, now, window);
  const [custom, setCustom] = useState(chosen === CUSTOM);
  const showPickers = custom || chosen === CUSTOM;

  return (
    <fieldset>
      <legend className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-[var(--ink-3)] uppercase">
        {legend}
      </legend>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={legend}>
        <Chip
          on={chosen === null && !custom}
          disabled={disabled}
          onClick={() => {
            setCustom(false);
            onChange({ date: "", time: "" });
          }}
        >
          {none}
        </Chip>
        {offered.map((preset) => (
          <Chip
            key={preset.key}
            on={chosen === preset.key && !custom}
            disabled={disabled}
            onClick={() => {
              setCustom(false);
              onChange(preset.resolve(now, window));
            }}
          >
            {preset.label}
          </Chip>
        ))}
        <Chip on={showPickers} disabled={disabled} onClick={() => setCustom(true)}>
          Pick a time…
        </Chip>
      </div>

      {showPickers ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Field label="Date" className="min-w-[8.5rem] flex-[2]">
            <input
              type="date"
              value={value.date}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, date: event.target.value })}
              className={CONTROL}
            />
          </Field>
          <Field label="Time" className="min-w-[6.5rem] flex-1">
            <input
              type="time"
              value={value.time}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, time: event.target.value })}
              className={CONTROL}
            />
          </Field>
        </div>
      ) : (
        chosen !== null && (
          <p className="mt-1.5 text-[12.5px] tabular-nums text-[var(--ink-2)]">{readable(value)}</p>
        )
      )}
      <p className="mt-1 text-[11.5px] text-[var(--ink-3)]">{hint}</p>
    </fieldset>
  );
};

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
  window = null,
}: {
  readonly campaignId: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  /** False once the campaign has started. The end stays editable regardless. */
  readonly startEditable: boolean;
  readonly canWrite: boolean;
  /** The campaign's hours, so the presets land on the first and last hour it may ring. */
  readonly window?: CampaignWindow | null;
}) => {
  const [state, action, pending] = useActionState(setScheduleAction, START);
  const [from, setFrom] = useState(parts(startsAt));
  const [to, setTo] = useState(parts(endsAt));
  // Read once: presets resolved against a clock that moves would flicker between chips.
  const [now] = useState(() => new Date());

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
          none="When I start it"
          presets={STARTS}
          value={from}
          now={now}
          window={window}
          disabled={locked}
          onChange={setFrom}
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
        none="When the list is done"
        presets={STOPS}
        value={to}
        now={now}
        window={window}
        disabled={locked}
        onChange={setTo}
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
        </div>
      )}
    </Stack>
  );
};
