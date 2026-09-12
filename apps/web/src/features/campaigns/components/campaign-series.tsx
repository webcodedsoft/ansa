"use client";

import { SERIES_EVERY, SERIES_RUN_FOR, type SeriesEvery, type SeriesRunFor } from "@ansa/shared/campaign";
import Link from "next/link";
import { startTransition, useActionState, useState } from "react";

import { Button, Notice, Stack, TextField } from "@/components/ui";
import { cn } from "@/lib/cn";
import { idleForm } from "@/lib/form-state";

import { runAgainAction, setSeriesStateAction, type SeriesState } from "../campaigns.actions";
import type { CampaignWindow } from "../campaigns.service";
import { CUSTOM, offeredPresets, parts, presetFor, readable, STARTS, type Parts } from "../schedule-presets";

const START: SeriesState = idleForm();

export interface SeriesView {
  readonly id: string;
  readonly templateId: string;
  readonly name: string;
  readonly every: SeriesEvery;
  readonly runFor: SeriesRunFor;
  readonly nextRunAt: string;
  readonly runsCreated: number;
  readonly state: "active" | "paused" | "ended";
}

export interface SeriesRunView {
  readonly campaignId: string;
  readonly runNumber: number;
  readonly status: string;
  readonly startsAt: string | null;
  readonly total: number;
  readonly answered: number;
}

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

const Choices = <K extends string>({
  legend,
  options,
  value,
  disabled,
  onChange,
}: {
  readonly legend: string;
  readonly options: readonly { readonly key: K; readonly label: string }[];
  readonly value: K;
  readonly disabled: boolean;
  readonly onChange: (next: K) => void;
}) => (
  <fieldset>
    <legend className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-[var(--ink-3)] uppercase">
      {legend}
    </legend>
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={legend}>
      {options.map((option) => (
        <Chip key={option.key} on={option.key === value} disabled={disabled} onClick={() => onChange(option.key)}>
          {option.label}
        </Chip>
      ))}
    </div>
  </fieldset>
);

const EVERY = (Object.keys(SERIES_EVERY) as SeriesEvery[]).map((key) => ({ key, label: SERIES_EVERY[key].label }));
const RUN_FOR = (Object.keys(SERIES_RUN_FOR) as SeriesRunFor[]).map((key) => ({
  key,
  label: SERIES_RUN_FOR[key].label,
}));

/** "Every month, each run open for a week." */
const rhythm = (series: SeriesView): string =>
  `${SERIES_EVERY[series.every].label}, each run open for ${SERIES_RUN_FOR[series.runFor].label.toLowerCase()}.`;

/**
 * Run this campaign again — or, once it does, the series it belongs to.
 *
 * Two faces of one card. Before: a rhythm, a run length and a first run, every one of them a
 * choice, with the same presets the schedule card uses for the first run so "tomorrow" means
 * the same thing on both. After: what the rhythm is, when the next run is, the runs so far as
 * links to ordinary campaign pages, and pause / resume / end on the series itself — distinct
 * from pausing a run, which is that run's own control.
 *
 * On a run rather than the template, the card says so and links back: a run's own settings
 * are its own, and the place to change the rhythm is the series.
 */
export const CampaignSeries = ({
  campaignId,
  campaignName,
  series,
  runs,
  isRun,
  window,
  canWrite,
  hasPurpose,
}: {
  readonly campaignId: string;
  readonly campaignName: string;
  readonly series: SeriesView | null;
  readonly runs: readonly SeriesRunView[];
  /** This campaign is one of the series' runs rather than its template. */
  readonly isRun: boolean;
  readonly window: CampaignWindow | null;
  readonly canWrite: boolean;
  readonly hasPurpose: boolean;
}) => {
  const [state, action, pending] = useActionState(runAgainAction, START);
  const [stateChange, changeState, changing] = useActionState(setSeriesStateAction, START);
  const [every, setEvery] = useState<SeriesEvery>("month");
  const [runFor, setRunFor] = useState<SeriesRunFor>("week");
  const [first, setFirst] = useState<Parts>(parts(null));
  const [custom, setCustom] = useState(false);
  const [now] = useState(() => new Date());

  if (series !== null) {
    const busy = changing || !canWrite;
    const move = (next: "active" | "paused" | "ended"): void => {
      const form = new FormData();
      form.set("campaignId", campaignId);
      form.set("state", next);
      startTransition(() => changeState(form));
    };
    return (
      <Stack gap="sm">
        {isRun && (
          <p className="text-[12.5px] text-[var(--ink-3)]">
            Created by the series{" "}
            <Link href={`/campaigns/${series.templateId}`} className="text-[var(--accent)] hover:underline">
              {series.name}
            </Link>
            . Its rhythm is set there; this run has its own dates and list.
          </p>
        )}
        <p className="text-[13px] text-[var(--ink)]">
          {rhythm(series)}{" "}
          {series.state === "active" && (
            <span className="tabular-nums text-[var(--ink-2)]">Next run {readable(parts(series.nextRunAt))}.</span>
          )}
          {series.state === "paused" && <span className="text-[var(--warn)]">Paused — no further runs until resumed.</span>}
          {series.state === "ended" && <span className="text-[var(--ink-3)]">Ended.</span>}
        </p>

        {stateChange.status === "failed" && <Notice tone="error">{stateChange.message}</Notice>}

        {!isRun && series.state !== "ended" && canWrite && (
          <div className="flex flex-wrap gap-2">
            {series.state === "active" ? (
              <Button size="sm" disabled={busy} onClick={() => move("paused")}>
                Pause the series
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => move("active")}>
                Resume
              </Button>
            )}
            <Button size="sm" disabled={busy} onClick={() => move("ended")}>
              End the series
            </Button>
          </div>
        )}

        {runs.length > 0 && (
          <div className="border-t border-[var(--hairline)] pt-3">
            <div className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-[var(--ink-3)] uppercase">
              Runs so far
            </div>
            <ul className="flex flex-col gap-1 text-[12.5px]">
              {runs.map((run) => (
                <li key={run.campaignId} className="flex items-center justify-between gap-3">
                  <Link
                    href={`/campaigns/${run.campaignId}`}
                    className={cn("hover:underline", run.campaignId === campaignId ? "text-[var(--ink)]" : "text-[var(--accent)]")}
                  >
                    Run {run.runNumber}
                    {run.campaignId === campaignId && " (this one)"}
                  </Link>
                  <span className="tabular-nums text-[var(--ink-3)]">
                    {run.startsAt === null ? "" : readable(parts(run.startsAt))} · {run.status} · {run.answered}/{run.total} answered
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {runs.length === 0 && series.state === "active" && (
          <p className="text-[11.5px] text-[var(--ink-3)]">
            No run yet. The first is created on the sweep after {readable(parts(series.nextRunAt))} and starts then.
          </p>
        )}
      </Stack>
    );
  }

  const offered = offeredPresets(STARTS, now, window);
  const chosen = presetFor(first, offered, now, window);
  const showPickers = custom || chosen === CUSTOM;
  const anchorAt =
    first.date === "" || first.time === "" ? null : new Date(`${first.date}T${first.time}`).toISOString();
  const locked = pending || !canWrite;

  const submit = (): void => {
    if (anchorAt === null) return;
    const form = new FormData();
    form.set("campaignId", campaignId);
    form.set("every", every);
    form.set("runFor", runFor);
    form.set("anchorAt", anchorAt);
    startTransition(() => action(form));
  };

  return (
    <Stack gap="sm">
      <p className="text-[12.5px] leading-relaxed text-[var(--ink-3)]">
        Each run is a campaign like this one — the same words, hours, pace and people — created
        and started on its own at every beat. Change this campaign and the next run picks it up.
      </p>

      {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}
      {state.status === "invalid" && <Notice tone="error">{state.message}</Notice>}
      {!hasPurpose && <Notice tone="warn">Say why it calls on the brief first; a run without a reason could not open.</Notice>}

      <Choices legend="How often" options={EVERY} value={every} disabled={locked} onChange={setEvery} />
      <Choices legend="Each run is open for" options={RUN_FOR} value={runFor} disabled={locked} onChange={setRunFor} />

      <fieldset>
        <legend className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-[var(--ink-3)] uppercase">
          First run
        </legend>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="First run">
          {offered.map((preset) => (
            <Chip
              key={preset.key}
              on={chosen === preset.key && !custom}
              disabled={locked}
              onClick={() => {
                setCustom(false);
                setFirst(preset.resolve(now, window));
              }}
            >
              {preset.label}
            </Chip>
          ))}
          <Chip on={showPickers} disabled={locked} onClick={() => setCustom(true)}>
            Pick a time…
          </Chip>
        </div>
        {showPickers ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <TextField
              label="Date"
              type="date"
              className="min-w-[8.5rem] flex-[2]"
              value={first.date}
              disabled={locked}
              onChange={(event) => setFirst({ ...first, date: event.target.value })}
            />
            <TextField
              label="Time"
              type="time"
              className="min-w-[6.5rem] flex-1"
              value={first.time}
              disabled={locked}
              onChange={(event) => setFirst({ ...first, time: event.target.value })}
            />
          </div>
        ) : (
          chosen !== null && (
            <p className="mt-1.5 text-[12.5px] tabular-nums text-[var(--ink-2)]">{readable(first)}</p>
          )
        )}
      </fieldset>

      {canWrite && (
        <div>
          <Button pending={pending} size="sm" variant="primary" disabled={locked || anchorAt === null || !hasPurpose} onClick={submit}>
            {`Run ${campaignName} again`}
          </Button>
        </div>
      )}
    </Stack>
  );
};
