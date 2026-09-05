"use client";

import { useActionState, useEffect } from "react";

import { Button, Modal, Notice, Row, SubmitButton, Tag } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import {
  cancelBookingAction,
  confirmBookingAction,
  type BookingState,
} from "../appointments.actions";
import { bookingWhen } from "../appointments.time";

const CONFIRM_START: BookingState = idleForm();
const CANCEL_START: BookingState = idleForm();

export interface BookingView {
  readonly id: string;
  readonly status: "held" | "booked";
  readonly startsAt: string;
  readonly endsAt: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly contactId: string | null;
  readonly notes: string | null;
  readonly holdExpiresAt: string | null;
  readonly source: string;
}

/**
 * One booking, opened from its block on the grid.
 *
 * A hold can be confirmed into a booking or cancelled; a booking can be cancelled. Confirm is
 * the load-bearing case: a hold that has lapsed cannot be confirmed — by then the slot is
 * somebody else's to take — and the API answers 409. The action turns that into a plain
 * sentence and refreshes the grid, so the reader is told the hold lapsed rather than shown a
 * raw conflict, and the released slot reappears as free behind the dialog.
 *
 * Cancelling something already cancelled is not an error the API raises, so the buttons do not
 * guard against a double click beyond disabling while the request is in flight.
 */
export const BookingDetails = ({
  booking,
  timeZone,
  canWrite,
  onClose,
}: {
  readonly booking: BookingView | null;
  readonly timeZone: string;
  readonly canWrite: boolean;
  readonly onClose: () => void;
}) => {
  const [confirmState, confirmAction, confirming] = useActionState(confirmBookingAction, CONFIRM_START);
  const [cancelState, cancelAction, cancelling] = useActionState(cancelBookingAction, CANCEL_START);

  useFormToast(confirmState, () => "Hold confirmed.");
  useFormToast(cancelState, () => "Booking cancelled.");

  useEffect(() => {
    if (confirmState.status === "succeeded" || cancelState.status === "succeeded") onClose();
  }, [confirmState, cancelState, onClose]);

  const failure =
    confirmState.status === "failed"
      ? confirmState.message
      : cancelState.status === "failed"
        ? cancelState.message
        : null;

  return (
    <Modal
      open={booking !== null}
      onClose={onClose}
      title={booking?.status === "held" ? "Held slot" : "Booking"}
      description={booking !== null ? `${bookingWhen(booking.startsAt, timeZone)} — ${timeZone}` : undefined}
      footer={
        booking !== null && canWrite ? (
          <>
            <Button onClick={onClose} disabled={confirming || cancelling}>
              Close
            </Button>
            <form action={cancelAction} className="contents">
              <input type="hidden" name="bookingId" value={booking.id} />
              <SubmitButton
                pending={cancelling}
                idle="Cancel booking"
                busy="Cancelling…"
                variant="danger"
              />
            </form>
            {booking.status === "held" && (
              <form action={confirmAction} className="contents">
                <input type="hidden" name="bookingId" value={booking.id} />
                <SubmitButton pending={confirming} idle="Confirm hold" busy="Confirming…" />
              </form>
            )}
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      {booking !== null && (
        <div className="flex flex-col gap-3 text-[13.5px]">
          {failure !== null && <Notice tone="error">{failure}</Notice>}

          <Row className="items-center gap-2">
            <Tag tone={booking.status === "held" ? "warn" : "accent"}>{booking.status}</Tag>
            <Tag tone="neutral">{booking.source}</Tag>
          </Row>

          {booking.status === "held" && booking.holdExpiresAt !== null && (
            <Notice tone="warn">
              This hold lapses at {bookingWhen(booking.holdExpiresAt, timeZone)}. Confirm it before
              then, or it is released for the next caller.
            </Notice>
          )}

          <div>
            <div className="text-[12px] text-[var(--ink-3)]">When</div>
            <div className="font-medium">
              {bookingWhen(booking.startsAt, timeZone)} – {bookingWhen(booking.endsAt, timeZone)}
            </div>
          </div>

          {booking.notes !== null && booking.notes !== "" && (
            <div>
              <div className="text-[12px] text-[var(--ink-3)]">Note</div>
              <div className="leading-relaxed whitespace-pre-wrap">{booking.notes}</div>
            </div>
          )}

          {!canWrite && (
            <Notice tone="info">
              You can view this booking. Confirming or cancelling needs the appointments:write
              permission.
            </Notice>
          )}
        </div>
      )}
    </Modal>
  );
};
