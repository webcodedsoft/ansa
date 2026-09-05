"use client";

import { Plus, Trash2 } from "lucide-react";
import { useActionState, useState } from "react";

import { Button, Card, IconButton, Notice } from "@/components/ui";
import { cn } from "@/lib/cn";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import { replaceAvailabilityAction, type AvailabilityState } from "../appointments.actions";
import type { AvailabilityWindows } from "../appointments.service";
import {
  availabilityProblem,
  minutesToTime,
  timeToMinutes,
  WEEKDAY_LABELS,
  type AvailabilityWindow,
} from "../appointments.time";

const START: AvailabilityState = idleForm();

/** Monday-first, the way a working week is read; Sunday last. */
const WEEKDAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

/** A row while it is being edited: times as the `HH:MM` a native time input holds. */
interface EditRow {
  readonly key: string;
  readonly weekday: number;
  readonly start: string;
  readonly end: string;
}

let rowCounter = 0;
const nextKey = (): string => {
  rowCounter += 1;
  return `row-${rowCounter}`;
};

const rowsFrom = (windows: AvailabilityWindows): EditRow[] =>
  windows.map((window) => ({
    key: nextKey(),
    weekday: window.weekday,
    start: minutesToTime(window.startMinute),
    end: minutesToTime(window.endMinute),
  }));

/**
 * Set a calendar's weekly open hours.
 *
 * The API takes the whole week at once and replaces it, so this holds the whole week and sends
 * the whole week — there is no "save Tuesday". Each weekday can carry any number of open
 * periods, which is why they are rows to add and remove rather than a single from/to per day:
 * a clinic that shuts for lunch has two.
 *
 * The two rules the API enforces are checked here first, against the named weekday, so the
 * operator hears "Tuesday: two open periods overlap" before a round trip rather than a body
 * error after one. The default hold is a plain Monday-to-Friday, nine to five, so an empty
 * calendar becomes a working one in one click and an edit from there.
 */
export const AvailabilityEditor = ({
  calendarId,
  windows,
  canWrite,
}: {
  readonly calendarId: string;
  readonly windows: AvailabilityWindows;
  readonly canWrite: boolean;
}) => {
  const [rows, setRows] = useState<EditRow[]>(() => rowsFrom(windows));
  const [localProblem, setLocalProblem] = useState<string | null>(null);
  const [state, dispatch, pending] = useActionState(replaceAvailabilityAction, START);
  useFormToast(state, (data) => (data.windowCount === 0 ? "Hours cleared." : "Hours saved."));

  const addRow = (weekday: number): void => {
    setLocalProblem(null);
    setRows((current) => [...current, { key: nextKey(), weekday, start: "09:00", end: "17:00" }]);
  };

  const removeRow = (key: string): void => {
    setLocalProblem(null);
    setRows((current) => current.filter((row) => row.key !== key));
  };

  const editRow = (key: string, field: "start" | "end", value: string): void => {
    setLocalProblem(null);
    setRows((current) => current.map((row) => (row.key === key ? { ...row, [field]: value } : row)));
  };

  const applyWeekdays = (source: number): void => {
    // A convenience nobody has to use: copy one weekday's periods onto Monday–Friday, since an
    // office keeps the same hours most days and typing them five times is the tedium this
    // removes. It never touches the weekend, which is the day most likely to differ.
    setLocalProblem(null);
    const template = rows.filter((row) => row.weekday === source);
    if (template.length === 0) return;
    setRows((current) => [
      ...current.filter((row) => ![1, 2, 3, 4, 5].includes(row.weekday)),
      ...[1, 2, 3, 4, 5].flatMap((weekday) =>
        template.map((row) => ({ key: nextKey(), weekday, start: row.start, end: row.end })),
      ),
    ]);
  };

  const seedWorkingWeek = (): void => {
    setLocalProblem(null);
    setRows(
      [1, 2, 3, 4, 5].map((weekday) => ({ key: nextKey(), weekday, start: "09:00", end: "17:00" })),
    );
  };

  const save = (): void => {
    const parsed: AvailabilityWindow[] = [];
    for (const row of rows) {
      const startMinute = timeToMinutes(row.start);
      const endMinute = timeToMinutes(row.end);
      if (startMinute === null || endMinute === null) {
        setLocalProblem(`${WEEKDAY_LABELS[row.weekday] ?? "A day"}: enter a start and end time.`);
        return;
      }
      parsed.push({ weekday: row.weekday, startMinute, endMinute });
    }
    const problem = availabilityProblem(parsed);
    if (problem !== null) {
      setLocalProblem(problem);
      return;
    }
    setLocalProblem(null);
    const form = new FormData();
    form.set("calendarId", calendarId);
    form.set("windows", JSON.stringify(parsed));
    dispatch(form);
  };

  const message = localProblem ?? (state.status === "failed" ? state.message : null);
  const isEmpty = rows.length === 0;

  return (
    <Card
      title="Weekly hours"
      description="The recurring hours this calendar is open. Set them once; slots are expanded from them in the calendar's timezone. Replacing them replaces the whole week."
      actions={
        canWrite ? (
          <Button variant="primary" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save hours"}
          </Button>
        ) : undefined
      }
    >
      {!canWrite && (
        <Notice tone="info" className="mb-4">
          You can view these hours. Changing them needs the appointments:write permission.
        </Notice>
      )}

      {message !== null && (
        <Notice tone="error" className="mb-4">
          {message}
        </Notice>
      )}

      {isEmpty && canWrite && (
        <Notice tone="warn" className="mb-4">
          This calendar has no open hours yet, so it offers no slots. Add hours to a weekday
          below, or{" "}
          <button type="button" className="underline underline-offset-2" onClick={seedWorkingWeek}>
            start from Monday–Friday, 9 to 5
          </button>
          .
        </Notice>
      )}

      <div className="flex flex-col gap-2.5">
        {WEEKDAY_ORDER.map((weekday) => {
          const dayRows = rows.filter((row) => row.weekday === weekday);
          return (
            <div
              key={weekday}
              className="flex flex-col gap-2 rounded-lg border border-[var(--surface-line)] p-3 sm:flex-row sm:items-start"
            >
              <div className="flex w-28 flex-none items-center justify-between sm:block">
                <span className="text-[13px] font-medium">{WEEKDAY_LABELS[weekday]}</span>
                {dayRows.length === 0 && (
                  <span className="text-[11.5px] text-[var(--ink-3)] sm:mt-0.5 sm:block">Closed</span>
                )}
              </div>

              <div className="flex min-w-0 flex-1 flex-col gap-2">
                {dayRows.map((row) => (
                  <div key={row.key} className="flex items-center gap-2">
                    <input
                      type="time"
                      aria-label={`${WEEKDAY_LABELS[weekday]} opens`}
                      value={row.start}
                      disabled={!canWrite}
                      onChange={(event) => editRow(row.key, "start", event.target.value)}
                      className={cn(
                        "rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-2.5 py-1.5 text-[13px] text-[var(--ink)]",
                        "tabular-nums disabled:opacity-55",
                      )}
                    />
                    <span aria-hidden className="text-[var(--ink-3)]">
                      –
                    </span>
                    <input
                      type="time"
                      aria-label={`${WEEKDAY_LABELS[weekday]} closes`}
                      value={row.end}
                      disabled={!canWrite}
                      onChange={(event) => editRow(row.key, "end", event.target.value)}
                      className={cn(
                        "rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-2.5 py-1.5 text-[13px] text-[var(--ink)]",
                        "tabular-nums disabled:opacity-55",
                      )}
                    />
                    {canWrite && (
                      <IconButton aria-label="Remove this period" onClick={() => removeRow(row.key)}>
                        <Trash2 aria-hidden className="size-4" />
                      </IconButton>
                    )}
                  </div>
                ))}
              </div>

              {canWrite && (
                <div className="flex flex-none items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => addRow(weekday)}>
                    <Plus aria-hidden className="size-4" />
                    Add hours
                  </Button>
                  {[1, 2, 3, 4, 5].includes(weekday) && dayRows.length > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => applyWeekdays(weekday)}
                      title="Copy these hours to Monday–Friday"
                    >
                      Copy to weekdays
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
};
