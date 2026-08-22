"use client";

import { useActionState } from "react";

import {
  Card,
  CheckboxField,
  CheckboxGroup,
  FieldError,
  Notice,
  NumberField,
  Stack,
  SubmitButton,
} from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { saveHours, type HoursState } from "../org.actions";
import type { Organisation } from "../org.service";

const START: HoursState = idleForm();

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
 */
export const HoursForm = ({ organisation }: { readonly organisation: Organisation }) => {
  const [state, action, pending] = useActionState(saveHours, START);
  const errors = state.fieldErrors;
  const hours = organisation.businessHours;
  const openDays = hours?.openDays ?? DEFAULT_OPEN_DAYS;

  return (
    <Card
      title="Business hours"
      description="When this organisation counts as open. Shared by every agent it runs, and applied on the next call — there is no version to publish."
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

          <div className="grid gap-3.5 sm:grid-cols-2">
            <NumberField
              label="Opens at"
              name="opensAtHour"
              min={0}
              max={23}
              defaultValue={hours?.opensAtHour ?? 9}
              error={errors["opensAtHour"]}
              hint="WAT, inclusive."
            />
            <NumberField
              label="Closes at"
              name="closesAtHour"
              min={1}
              max={24}
              defaultValue={hours?.closesAtHour ?? 17}
              error={errors["closesAtHour"]}
              hint="WAT, exclusive — a line that shuts at five holds 17."
            />
          </div>

          <div>
            <CheckboxGroup legend="Open days">
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

          <div>
            <SubmitButton pending={pending} idle="Save hours" busy="Saving…" variant="primary" />
          </div>
        </Stack>
      </form>
    </Card>
  );
};
