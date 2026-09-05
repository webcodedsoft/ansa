"use client";

import { useActionState, useEffect, useState } from "react";

import { Button, Modal, Notice, NumberField, SelectField, TextAreaField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import { createBookingAction, type BookingState, type ContactMatch } from "../appointments.actions";
import { bookingWhen } from "../appointments.time";
import { ContactPicker } from "./contact-picker";

const START: BookingState = idleForm();

export interface SlotChoice {
  readonly start: string;
  readonly end: string;
}

/**
 * Book or hold one free slot.
 *
 * Opened from a slot on the grid, so the time is already decided and shown rather than typed —
 * the operator chooses only how it is taken and who it is for. Booking takes the chair
 * outright; a hold reserves it for a set number of minutes while a caller makes up their mind,
 * which is the same thing the agent does on a live call.
 *
 * A 409 — the slot taken between being offered and being booked — is not shown as an error
 * about a request. The action refreshes the grid so the taken slot leaves it and returns a
 * plain sentence, which lands here and asks the operator to pick another.
 */
export const BookingDialog = ({
  calendarId,
  slot,
  timeZone,
  onClose,
}: {
  readonly calendarId: string;
  /** The slot to book, or null when the dialog is closed. */
  readonly slot: SlotChoice | null;
  readonly timeZone: string;
  readonly onClose: () => void;
}) => {
  const [state, action, pending] = useActionState(createBookingAction, START);
  const [mode, setMode] = useState<"booked" | "held">("booked");
  const [contact, setContact] = useState<ContactMatch | null>(null);

  useFormToast(state, (data) => (data.status === "held" ? "Slot held." : "Slot booked."));

  useEffect(() => {
    if (state.status === "succeeded") {
      setContact(null);
      onClose();
    }
  }, [state, onClose]);

  // A fresh slot starts a fresh choice: reset the contact when a different slot is opened.
  useEffect(() => {
    if (slot !== null) setContact(null);
  }, [slot]);

  return (
    <Modal
      open={slot !== null}
      onClose={onClose}
      title="Book this slot"
      description={slot !== null ? `${bookingWhen(slot.start, timeZone)} — ${timeZone}` : undefined}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            form="booking-form"
            type="submit"
            disabled={pending || slot === null}
          >
            {pending ? "Saving…" : mode === "held" ? "Hold slot" : "Book slot"}
          </Button>
        </>
      }
    >
      {slot !== null && (
        <form id="booking-form" action={action} className="flex flex-col gap-3.5">
          <input type="hidden" name="calendarId" value={calendarId} />
          <input type="hidden" name="startsAt" value={slot.start} />
          <input type="hidden" name="status" value={mode} />
          {contact !== null && <input type="hidden" name="contactId" value={contact.id} />}

          {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}

          <SelectField
            label="How to take it"
            value={mode}
            onChange={(event) => setMode(event.target.value as "booked" | "held")}
            hint={
              mode === "held"
                ? "Reserved for a while, then released if not confirmed."
                : "Taken outright — the chair is theirs."
            }
          >
            <option value="booked">Book it</option>
            <option value="held">Hold it</option>
          </SelectField>

          {mode === "held" && (
            <NumberField
              label="Hold for"
              name="holdMinutes"
              defaultValue={15}
              min={1}
              step={5}
              error={state.fieldErrors["holdMinutes"]}
              hint="Minutes before the hold lapses and the slot is offered again."
            />
          )}

          <div>
            <span className="mb-1.5 block text-[12.5px] font-medium">Contact</span>
            <ContactPicker value={contact} onChange={setContact} />
          </div>

          <TextAreaField
            label="Note"
            name="notes"
            defaultValue=""
            error={state.fieldErrors["notes"]}
            placeholder="Anything the person at the desk should know (optional)"
          />
        </form>
      )}
    </Modal>
  );
};
