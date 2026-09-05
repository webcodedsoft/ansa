"use client";

import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { useActionState, useEffect, useState } from "react";

import {
  Button,
  Modal,
  Notice,
  NumberField,
  SelectField,
  SubmitButton,
  TextField,
} from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import { createCalendarAction, type CalendarState } from "../appointments.actions";
import { TimezoneSelect } from "./timezone-select";

const START: CalendarState = idleForm();

/**
 * Create a calendar, in a dialog off the appointments page.
 *
 * The source toggle changes what the form asks: a hosted calendar is kept here and needs
 * nothing more, while a connector calendar mirrors an outside diary and cannot exist without
 * the reference it has there. That reference field appears only for a connector, because a
 * field that is required sometimes and forbidden the rest of the time is clearer shown and
 * hidden than left visible with a caveat.
 *
 * On success the dialog closes and the page navigates to the new calendar, so the operator
 * lands on the thing they just made rather than back on whichever one was open.
 */
export const CreateCalendarDialog = ({
  trigger = "primary",
}: {
  /** `primary` for the empty-state call to action, `secondary` for the header beside a list. */
  readonly trigger?: "primary" | "secondary";
}) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<"hosted" | "connector">("hosted");
  const [state, action, pending] = useActionState(createCalendarAction, START);

  useFormToast(state, () => "Calendar created.");

  useEffect(() => {
    if (state.status === "succeeded" && state.data !== null) {
      setOpen(false);
      router.push(`/appointments?calendar=${encodeURIComponent(state.data.calendarId)}`);
    }
  }, [state, router]);

  const fieldError = (name: string): string | undefined => state.fieldErrors[name];

  return (
    <>
      <Button variant={trigger} onClick={() => setOpen(true)}>
        <Plus aria-hidden className="size-4" />
        New calendar
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New calendar"
        description="A calendar has a timezone, a slot length and a buffer between bookings. Set its open hours after it exists."
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <SubmitButton
              form="create-calendar-form"
              pending={pending}
              idle="Create calendar"
              busy="Creating…"
            />
          </>
        }
      >
        <form id="create-calendar-form" action={action} className="flex flex-col gap-3.5">
          {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}

          <TextField
            label="Name"
            name="name"
            required
            defaultValue=""
            placeholder="Consulting room, Test drives, Clinic A"
            error={fieldError("name")}
            autoComplete="off"
          />

          <TimezoneSelect error={fieldError("timezone")} />

          <div className="grid grid-cols-2 gap-3.5">
            <NumberField
              label="Slot length"
              name="slotMinutes"
              required
              defaultValue={30}
              min={5}
              step={5}
              error={fieldError("slotMinutes")}
              hint="Minutes per appointment."
            />
            <NumberField
              label="Buffer"
              name="bufferMinutes"
              required
              defaultValue={0}
              min={0}
              step={5}
              error={fieldError("bufferMinutes")}
              hint="Minutes kept free either side."
            />
          </div>

          <SelectField
            label="Source"
            name="source"
            value={source}
            onChange={(event) => setSource(event.target.value as "hosted" | "connector")}
            hint={
              source === "hosted"
                ? "Kept here. Ansa owns the hours and the bookings."
                : "Mirrors an outside diary. Give the reference it has there."
            }
          >
            <option value="hosted">Hosted here</option>
            <option value="connector">Connector (outside diary)</option>
          </SelectField>

          {source === "connector" && (
            <TextField
              label="External reference"
              name="externalRef"
              required
              defaultValue=""
              placeholder="The id or URL of the diary this mirrors"
              error={fieldError("externalRef")}
              autoComplete="off"
            />
          )}
        </form>
      </Modal>
    </>
  );
};
