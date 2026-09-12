"use client";

import { CalendarOff, Clock, PhoneIncoming, Plus, X } from "lucide-react";
import { useActionState, useState } from "react";

import {
  Button,
  CONTROL,
  Card,
  CheckboxField,
  CheckboxGroup,
  FieldError,
  Notice,
  SelectField,
  Stack,
  SubmitButton,
  Tag,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { idleForm } from "@/lib/form-state";

import { saveHours, type HoursState } from "../org.actions";
import { shortDate } from "../org.display";
import type { Organisation } from "../org.service";

const START: HoursState = idleForm();

/** Hours as a clock shows them, so "17" is chosen as 17:00 and never typed as 5. */
const hourOptions = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i).map((hour) => (
    <option key={hour} value={hour}>
      {`${String(hour).padStart(2, "0")}:00`}
    </option>
  ));

const DAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
] as const;

const DEFAULT_OPEN_DAYS: readonly number[] = [1, 2, 3, 4, 5];

/**
 * When this organisation counts as open.
 *
 * This card used to sit on an agent's Routing & hours tab and was written by publishing that
 * agent. Both halves of that were wrong. The columns are on `organizations`, so one agent's
 * form was setting hours for every agent the organisation runs — invisible with one agent and
 * a silent bug with two. And a publish was the only way to change them despite no
 * configuration version ever carrying hours: the snapshot has no columns for them, so a diff
 * always said "unchanged" and a rollback could never restore one.
 *
 * So there is no Save-then-Publish here, and its absence is the design rather than an
 * omission. A draft exists so an agent's *words* can be changed without a caller hearing them
 * half-written. Hours have no half-written state and nowhere to wait, so staging them would be
 * a second mechanism protecting nothing.
 *
 * Closed days are the holes in the weekly pattern — public holidays. They are dates, not
 * weekdays, and the hole wins: a Tuesday in the list is closed however many Tuesdays the
 * organisation is normally open. `open` is worked out on the server so the badge and the
 * page header say the same thing.
 */
export const HoursForm = ({
  organisation,
  open,
  nowLabel,
}: {
  readonly organisation: Organisation;
  readonly open: boolean;
  readonly nowLabel: string;
}) => {
  const [state, action, pending] = useActionState(saveHours, START);
  const errors = state.fieldErrors;
  const hours = organisation.businessHours;
  const openDays = hours?.openDays ?? DEFAULT_OPEN_DAYS;
  /* Rows, not values: an empty row is a date somebody is about to pick, and the action
     drops it if they never do. Keyed by a counter so removing the middle one does not
     reassign the others' inputs. */
  const [rows, setRows] = useState<readonly { readonly key: number; readonly date: string }[]>(
    () => (hours?.closedDates ?? []).map((date, key) => ({ key, date })),
  );
  const [nextKey, setNextKey] = useState(rows.length);

  const addRow = () => {
    setRows((current) => [...current, { key: nextKey, date: "" }]);
    setNextKey((k) => k + 1);
  };
  const removeRow = (key: number) => setRows((current) => current.filter((r) => r.key !== key));

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Clock aria-hidden className="size-4 text-[var(--ink-3)]" />
          Business hours
        </span>
      }
      description="Shared by every agent this organisation runs. Applies from the next call — there is no version to publish."
      actions={
        <Tag tone={open ? "ok" : "neutral"}>
          {open ? "open now" : "closed now"} · {nowLabel} WAT
        </Tag>
      }
    >
      <form action={action}>
        <Stack>
          {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}
          {state.status === "succeeded" && <Notice tone="ok">Saved. Calls use these now.</Notice>}

          <CheckboxField
            label="Restrict to set hours"
            name="hoursEnabled"
            defaultChecked={hours !== null}
          />

          <div>
            <CheckboxGroup legend="Open on">
              {DAYS.map((day) => (
                <CheckboxField
                  key={day.value}
                  label={day.label}
                  name="openDays"
                  value={day.value}
                  defaultChecked={openDays.includes(day.value)}
                />
              ))}
            </CheckboxGroup>
            {errors["openDays"] !== undefined && <FieldError>{errors["openDays"]}</FieldError>}
          </div>

          <div className="grid gap-3.5 sm:grid-cols-2">
            <SelectField
              label="Opens"
              name="opensAtHour"
              defaultValue={hours?.opensAtHour ?? 9}
              error={errors["opensAtHour"]}
              hint="WAT. The first hour a call is taken."
            >
              {hourOptions(0, 23)}
            </SelectField>
            <SelectField
              label="Closes"
              name="closesAtHour"
              defaultValue={hours?.closesAtHour ?? 17}
              error={errors["closesAtHour"]}
              hint="WAT. Calls stop at this hour, so 17:00 means the last call is before five."
            >
              {hourOptions(1, 24)}
            </SelectField>
          </div>

          <fieldset className="m-0 min-w-0 border-0 p-0">
            <legend className="mb-1.5 flex items-center gap-2 text-[12.5px] font-medium">
              <CalendarOff aria-hidden className="size-3.5 text-[var(--ink-3)]" />
              Closed days
              <span className="font-normal text-[var(--ink-3)]">
                {rows.filter((r) => r.date !== "").length === 0
                  ? "none"
                  : rows
                      .filter((r) => r.date !== "")
                      .map((r) => shortDate(r.date))
                      .join(", ")}
              </span>
            </legend>
            <div className="flex flex-col gap-2">
              {rows.map((row) => (
                <div key={row.key} className="flex items-center gap-2">
                  <input
                    type="date"
                    name="closedDates"
                    defaultValue={row.date}
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((r) => (r.key === row.key ? { ...r, date: event.target.value } : r)),
                      )
                    }
                    aria-label="Closed date"
                    className={cn(CONTROL, "max-w-[14rem] font-mono")}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeRow(row.key)}
                    aria-label="Remove this date"
                  >
                    <X aria-hidden className="size-3.5" />
                  </Button>
                </div>
              ))}
              <div>
                <Button type="button" variant="secondary" size="sm" onClick={addRow}>
                  <Plus aria-hidden className="size-3.5" />
                  Add a date
                </Button>
              </div>
            </div>
            {errors["closedDates"] !== undefined && <FieldError>{errors["closedDates"]}</FieldError>}
            <p className="mt-1.5 mb-0 text-[12px] text-[var(--ink-3)]">
              Public holidays and the like. A date here is closed whatever the weekday says.
            </p>
          </fieldset>

          <div className="flex items-start gap-2.5 rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-3.5 py-3 text-[12.5px] text-[var(--ink-2)]">
            <PhoneIncoming aria-hidden className="mt-0.5 size-3.5 flex-none text-[var(--ink-3)]" />
            <span>
              Outside these hours the agent still answers. It is told the line is closed and not
              to promise anything for today, and the hours tool tells a caller when you open again.
            </span>
          </div>

          <div>
            <SubmitButton pending={pending} idle="Save hours" variant="primary" />
          </div>
        </Stack>
      </form>
    </Card>
  );
};
