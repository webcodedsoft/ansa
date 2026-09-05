"use client";

import { useActionState, useEffect, useId, useMemo, useState } from "react";

import {
  Button,
  Modal,
  Notice,
  NumberField,
  SelectField,
  SubmitButton,
  Tag,
  TextAreaField,
  TextField,
} from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import {
  cancelBookingAction,
  confirmBookingAction,
  createBookingAction,
  editBookingAction,
  type BookingState,
  type ContactMatch,
} from "../appointments.actions";
import { minuteToInput } from "../appointments.drag";
import {
  bookingWhen,
  parseIsoDate,
  timeToMinutes,
  zonedParts,
  zonedTimeToUtc,
} from "../appointments.time";
import type { BookingView, DraftSpan } from "../appointments.view";
import { ContactPicker } from "./contact-picker";

const START: BookingState = idleForm();

/** What the dialog is open on: a span to fill, an appointment to edit, or nothing. */
export type DialogTarget =
  | { readonly kind: "new"; readonly span: DraftSpan }
  | { readonly kind: "existing"; readonly booking: BookingView }
  | null;

interface Draft {
  readonly dayIso: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly title: string;
  readonly notes: string;
}

/**
 * Read an existing appointment back into the boxes that edit it.
 *
 * Off `startsAt` and `endsAt` rather than the `startMinute` the grid placed it at: those are
 * clamped to the column they were drawn in, so an appointment crossing midnight would edit as
 * though it ended at midnight. The instants are the truth and the calendar's zone decides what
 * clock they read as.
 */
const draftOf = (booking: BookingView, timeZone: string): Draft => {
  const from = zonedParts(new Date(booking.startsAt), timeZone);
  const to = zonedParts(new Date(booking.endsAt), timeZone);
  return {
    dayIso: `${String(from.year).padStart(4, "0")}-${String(from.month).padStart(2, "0")}-${String(from.day).padStart(2, "0")}`,
    startTime: minuteToInput(from.hour * 60 + from.minute),
    endTime: minuteToInput(to.hour * 60 + to.minute),
    title: booking.title ?? "",
    notes: booking.notes ?? "",
  };
};

const draftOfSpan = (span: DraftSpan): Draft => ({
  dayIso: span.dayIso,
  startTime: minuteToInput(span.startMinute),
  endTime: minuteToInput(span.endMinute),
  title: "",
  notes: "",
});

/**
 * One appointment, being written or being changed.
 *
 * The same dialog for both, because they are the same form: a name, a day, two times, who it
 * is for and a note. Splitting them produced two places to add a field to and two places to
 * get the timezone wrong. What differs is only what the buttons do — a new appointment can be
 * booked outright or held for a while, an existing one can be saved, confirmed or cancelled.
 *
 * **Times are resolved here, once.** The boxes hold wall-clock times in the *calendar's* zone,
 * and the hidden fields that actually travel are instants produced by `zonedTimeToUtc`. The
 * browser's own zone never touches an appointment: a desk in London booking into a Lagos
 * calendar types 14:00 and means 14:00 in Lagos, which is the only reading that is ever
 * useful and the one the person on the phone will hear.
 *
 * An end before its start is caught here so the message lands under the End box, and again by
 * the API, which owns the rule. A 409 — the minute taken between opening this and saving it —
 * comes back from the action as a sentence, having already refreshed the grid behind.
 */
export const AppointmentDialog = ({
  calendarId,
  target,
  timeZone,
  canWrite,
  onClose,
}: {
  readonly calendarId: string;
  readonly target: DialogTarget;
  readonly timeZone: string;
  readonly canWrite: boolean;
  readonly onClose: () => void;
}) => {
  const [createState, create, creating] = useActionState(createBookingAction, START);
  const [editState, edit, editing] = useActionState(editBookingAction, START);
  const [confirmState, confirm, confirming] = useActionState(confirmBookingAction, START);
  const [cancelState, cancel, cancelling] = useActionState(cancelBookingAction, START);

  const booking = target?.kind === "existing" ? target.booking : null;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [mode, setMode] = useState<"booked" | "held">("booked");
  const [contact, setContact] = useState<ContactMatch | null>(null);
  const [contactChanged, setContactChanged] = useState(false);

  /* Every open is a fresh form. Without this the previous appointment's title would still be
     in the box when the next block is clicked, and the operator would save it onto the wrong
     one — the classic uncontrolled-input carry-over, made worse here because it looks right. */
  useEffect(() => {
    if (target === null) return;
    setDraft(target.kind === "new" ? draftOfSpan(target.span) : draftOf(target.booking, timeZone));
    setMode("booked");
    setContact(null);
    setContactChanged(false);
  }, [target, timeZone]);

  useFormToast(createState, (data) => (data.status === "held" ? "Slot held." : "Appointment booked."));
  useFormToast(editState, () => "Appointment saved.");
  useFormToast(confirmState, () => "Hold confirmed.");
  useFormToast(cancelState, () => "Appointment cancelled.");

  useEffect(() => {
    if (
      createState.status === "succeeded" ||
      editState.status === "succeeded" ||
      confirmState.status === "succeeded" ||
      cancelState.status === "succeeded"
    ) {
      onClose();
    }
  }, [createState, editState, confirmState, cancelState, onClose]);

  const busy = creating || editing || confirming || cancelling;

  /* The instants that actually travel. Null when the boxes do not yet read as a time, which
     is what disables the save rather than sending something the API has to reject. */
  const instants = useMemo(() => {
    if (draft === null) return null;
    const date = parseIsoDate(draft.dayIso);
    const startMinute = timeToMinutes(draft.startTime);
    const endMinute = timeToMinutes(draft.endTime);
    if (date === null || startMinute === null || endMinute === null) return null;
    return {
      startMinute,
      endMinute,
      startsAt: zonedTimeToUtc(date, startMinute, timeZone).toISOString(),
      endsAt: zonedTimeToUtc(date, endMinute, timeZone).toISOString(),
    };
  }, [draft, timeZone]);

  const backwards = instants !== null && instants.endMinute <= instants.startMinute;

  const failure =
    createState.status === "failed"
      ? createState.message
      : editState.status === "failed"
        ? editState.message
        : confirmState.status === "failed"
          ? confirmState.message
          : cancelState.status === "failed"
            ? cancelState.message
            : null;

  const fieldErrors = booking === null ? createState.fieldErrors : editState.fieldErrors;
  const endError = backwards
    ? "An appointment has to end after it starts."
    : fieldErrors["endsAt"];

  const set = (patch: Partial<Draft>): void =>
    setDraft((current) => (current === null ? current : { ...current, ...patch }));

  /* Untouched means "leave whoever is attached alone", which for a form means sending the id
     it already had. The picker cannot show their name — a booking carries an id, not a name —
     so the choice is between saying so and silently dropping the contact on every save. */
  const contactId = contactChanged ? (contact?.id ?? "") : (booking?.contactId ?? "");
  /* Unique per instance rather than a literal, because a `form=` attribute binds to the first
     element in the document carrying that id — a shared one silently submits somebody else's
     form the moment a second dialog is on the page. */
  const formId = useId();

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title={booking === null ? "New appointment" : "Appointment"}
      description={
        instants !== null ? `${bookingWhen(instants.startsAt, timeZone)} — ${timeZone}` : timeZone
      }
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {canWrite ? "Cancel" : "Close"}
          </Button>

          {canWrite && booking !== null && (
            <form action={cancel} className="contents">
              <input type="hidden" name="bookingId" value={booking.id} />
              <SubmitButton
                pending={cancelling}
                idle="Cancel appointment"
                busy="Cancelling…"
                variant="danger"
              />
            </form>
          )}

          {canWrite && booking !== null && booking.status === "held" && (
            <form action={confirm} className="contents">
              <input type="hidden" name="bookingId" value={booking.id} />
              <SubmitButton pending={confirming} idle="Confirm hold" busy="Confirming…" />
            </form>
          )}

          {canWrite && (
            <Button
              variant="primary"
              form={formId}
              type="submit"
              disabled={busy || instants === null || backwards}
            >
              {booking !== null
                ? editing
                  ? "Saving…"
                  : "Save"
                : creating
                  ? "Saving…"
                  : mode === "held"
                    ? "Hold slot"
                    : "Book it"}
            </Button>
          )}
        </>
      }
    >
      {draft !== null && (
        <form
          id={formId}
          action={booking === null ? create : edit}
          className="flex flex-col gap-3.5"
        >
          {booking === null ? (
            <>
              <input type="hidden" name="calendarId" value={calendarId} />
              <input type="hidden" name="status" value={mode} />
            </>
          ) : (
            <input type="hidden" name="bookingId" value={booking.id} />
          )}
          <input type="hidden" name="startsAt" value={instants?.startsAt ?? ""} />
          <input type="hidden" name="endsAt" value={instants?.endsAt ?? ""} />
          <input type="hidden" name="contactId" value={contactId} />

          {failure !== null && <Notice tone="error">{failure}</Notice>}

          {booking !== null && (
            <div className="flex items-center gap-2">
              <Tag tone={booking.status === "held" ? "warn" : "accent"}>{booking.status}</Tag>
              <Tag tone="neutral">{booking.source}</Tag>
            </div>
          )}

          {booking !== null && booking.status === "held" && booking.holdExpiresAt !== null && (
            <Notice tone="warn">
              This hold lapses at {bookingWhen(booking.holdExpiresAt, timeZone)}. Confirm it before
              then, or it is released for the next caller.
            </Notice>
          )}

          <TextField
            label="Title"
            name="title"
            /* Focused on open: the dialog exists to name the appointment, and typing the
               name is the first thing a person does after drawing a span. */
            autoFocus
            value={draft.title}
            onChange={(event) => set({ title: event.target.value })}
            error={fieldErrors["title"]}
            placeholder="What is it? (optional)"
            maxLength={200}
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <TextField
              label="Date"
              type="date"
              value={draft.dayIso}
              onChange={(event) => set({ dayIso: event.target.value })}
              required
            />
            <TextField
              label="From"
              type="time"
              value={draft.startTime}
              onChange={(event) => set({ startTime: event.target.value })}
              error={fieldErrors["startsAt"]}
              required
            />
            <TextField
              label="To"
              type="time"
              value={draft.endTime}
              onChange={(event) => set({ endTime: event.target.value })}
              error={endError}
              required
            />
          </div>

          {booking === null && (
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
          )}

          {booking === null && mode === "held" && (
            <NumberField
              label="Hold for"
              name="holdMinutes"
              defaultValue={15}
              min={1}
              step={5}
              error={fieldErrors["holdMinutes"]}
              hint="Minutes before the hold lapses and the slot is offered again."
            />
          )}

          <div>
            <span className="mb-1.5 block text-[12.5px] font-medium">Contact</span>
            {booking !== null && booking.contactId !== null && !contactChanged ? (
              <div className="flex items-center gap-2 text-[13px] text-[var(--ink-2)]">
                <span>A contact is attached to this appointment.</span>
                <Button size="sm" onClick={() => setContactChanged(true)}>
                  Change
                </Button>
              </div>
            ) : (
              <ContactPicker
                value={contact}
                onChange={(next) => {
                  setContact(next);
                  setContactChanged(true);
                }}
              />
            )}
          </div>

          <TextAreaField
            label="Note"
            name="notes"
            value={draft.notes}
            onChange={(event) => set({ notes: event.target.value })}
            error={fieldErrors["notes"]}
            placeholder="Anything the person at the desk should know (optional)"
          />

          {!canWrite && (
            <Notice tone="info">
              You can view this appointment. Changing it needs the appointments:write permission.
            </Notice>
          )}
        </form>
      )}
    </Modal>
  );
};
