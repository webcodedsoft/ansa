"use client";

import { useActionState, useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";

import { Button, EmptyState, Notice, SubmitButton, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import {
  addHolidayAction,
  removeHolidayAction,
  type HolidayState,
} from "../appointments.actions";
import type { Holiday } from "../appointments.service";

const ADD: HolidayState = idleForm();
const DROP: HolidayState = idleForm();

/**
 * The days the office is shut.
 *
 * This is not decoration on the calendar. A date listed here suppresses every free slot on it
 * across every calendar the organisation keeps, which is what stops the agent offering a
 * caller a time on Christmas morning — in code, where a prompt cannot be talked out of it.
 *
 * What it deliberately does not do is forbid an appointment. An office that opens specially on
 * a public holiday still writes it in the diary, and one already written stays. Withholding
 * the offer and forbidding the booking are different things and only the first is what a
 * closure means.
 *
 * No recurrence rule. Eid moves, Christmas does not, and a rule general enough for both is a
 * rule nobody can read — so next year's Christmas is next year's row, and the list says
 * exactly which days are shut rather than implying them.
 */
export const HolidaysEditor = ({
  holidays,
  canWrite,
}: {
  readonly holidays: readonly Holiday[];
  readonly canWrite: boolean;
}) => {
  const [addState, add, adding] = useActionState(addHolidayAction, ADD);
  const [dropState, drop] = useActionState(removeHolidayAction, DROP);
  const form = useRef<HTMLFormElement | null>(null);

  useFormToast(addState, () => "Marked shut.");
  useFormToast(dropState, () => "That day is open again.");

  /* Clear the boxes after a save, or the day just added sits in them looking unsaved and
     invites being added a second time — which the API answers with a 409. */
  useEffect(() => {
    if (addState.status === "succeeded") form.current?.reset();
  }, [addState]);

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="info">
        On these days no calendar offers a caller a slot. Appointments already written on one
        stay, and you can still write a new one — that is how an office opening specially
        records it.
      </Notice>

      {canWrite && (
        <form ref={form} action={add} className="flex flex-wrap items-end gap-2">
          <TextField label="Date" name="onDate" type="date" required className="w-[168px]" />
          <TextField
            label="What it is"
            name="name"
            placeholder="Independence Day"
            required
            className="min-w-[180px] flex-1"
            error={addState.fieldErrors["name"]}
          />
          <SubmitButton pending={adding} idle="Mark shut" busy="Saving…" />
        </form>
      )}

      {addState.status === "failed" && <Notice tone="error">{addState.message}</Notice>}
      {dropState.status === "failed" && <Notice tone="error">{dropState.message}</Notice>}

      {holidays.length === 0 ? (
        <EmptyState title="No closures set">
          Every day is treated as open. Add the public holidays this office keeps, and the agent
          will stop offering callers times on them.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-[var(--surface-line)] rounded-lg border border-[var(--hairline)]">
          {holidays.map((holiday) => (
            <li key={holiday.id} className="flex items-center gap-3 px-3 py-2">
              <span className="w-[104px] shrink-0 text-[12.5px] tabular-nums text-[var(--ink-3)]">
                {holiday.onDate}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13.5px]">{holiday.name}</span>
              {canWrite && (
                <form action={drop}>
                  <input type="hidden" name="holidayId" value={holiday.id} />
                  <Button
                    size="sm"
                    type="submit"
                    aria-label={`Open ${holiday.name} again`}
                    className="px-2"
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
