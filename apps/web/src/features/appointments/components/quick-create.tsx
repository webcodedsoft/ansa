"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import { Button, Notice, SELECT_MENU_CLASS } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import { createBookingAction, type BookingState } from "../appointments.actions";
import { minuteToInput } from "../appointments.drag";
import { parseIsoDate, timeToMinutes, zonedTimeToUtc } from "../appointments.time";
import { TimeSelect } from "./time-select";
import type { DraftSpan } from "../appointments.view";

const START: BookingState = idleForm();

/** Where the popover was asked for, in viewport coordinates. */
export interface Anchor {
  readonly x: number;
  readonly y: number;
}

const CARD_WIDTH = 352;
const CARD_HEIGHT = 268;
const EDGE = 12;

/**
 * Keep the card on screen.
 *
 * It opens beside where you clicked, which near the right edge or the last row of the month
 * would otherwise put half of it past the fold — and a Save button you cannot reach is worse
 * than a card in slightly the wrong place. Falls back to the left of the pointer, then to the
 * edge itself.
 */
const place = (anchor: Anchor): { readonly left: number; readonly top: number } => {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const left = Math.min(Math.max(anchor.x + 12, EDGE), Math.max(vw - CARD_WIDTH - EDGE, EDGE));
  const top = Math.min(Math.max(anchor.y - 20, EDGE), Math.max(vh - CARD_HEIGHT - EDGE, EDGE));
  return { left, top };
};

/**
 * The quick way to write an appointment: a card where you clicked, a name, and Save.
 *
 * Most appointments need a name and a time, and the time is already decided by where the
 * click landed — so asking for a full dialog, with contact, note, and hold options, is asking
 * five questions to answer one. This is the Google Calendar shape: type a title, press Save,
 * done, with "More options" there for the times you do need the rest.
 *
 * Enter saves, Escape closes. Both matter more here than in a modal, because the whole point
 * is that the card is over in two keystrokes.
 *
 * Times resolve through `zonedTimeToUtc` in the *calendar's* zone, exactly as the full dialog
 * does — the browser's zone never gets a vote about when an appointment is.
 */
export const QuickCreate = ({
  calendarId,
  span,
  anchor,
  timeZone,
  onClose,
  onMoreOptions,
}: {
  readonly calendarId: string;
  readonly span: DraftSpan | null;
  readonly anchor: Anchor | null;
  readonly timeZone: string;
  readonly onClose: () => void;
  readonly onMoreOptions: (span: DraftSpan) => void;
}) => {
  const [state, action, pending] = useActionState(createBookingAction, START);
  const [title, setTitle] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("09:30");
  const card = useRef<HTMLDivElement | null>(null);

  useFormToast(state, () => "Appointment booked.");

  useEffect(() => {
    if (span === null) return;
    setTitle("");
    setStartTime(minuteToInput(span.startMinute));
    setEndTime(minuteToInput(span.endMinute));
  }, [span]);

  useEffect(() => {
    if (state.status === "succeeded") onClose();
  }, [state, onClose]);

  /* Escape closes, and a press outside closes — the two ways out of a popover a person
     expects without being told. Pointerdown rather than click, so it closes on the press
     that lands elsewhere rather than waiting for the release.
     
     Both have to know about the time list. It is portalled to the body, so by the DOM a press
     on "10:30am" is nowhere near this card — choosing a time closed the card instead of
     setting it. The same for Escape, which should shut the open list first and only close the
     card when there is no list to shut. */
  useEffect(() => {
    if (span === null) return;
    const menuIsOpen = (): boolean => document.querySelector(`.${SELECT_MENU_CLASS}`) !== null;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !menuIsOpen()) onClose();
    };
    const onDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target instanceof Element && target.closest(`.${SELECT_MENU_CLASS}`) !== null) return;
      if (card.current !== null && !card.current.contains(target)) onClose();
    };
    /* Capture, not bubble. The list closes itself on Escape from its own handler, which runs
       first on the way up — so by the time a bubbled listener looked, there was no open list
       to find and the card closed along with it. Capturing puts this question before the
       answer. */
    window.addEventListener("keydown", onKey, true);
    /* Deferred a frame: the very press that opened this card is still being delivered, and
       without the wait it would close the card it just opened. */
    const id = window.setTimeout(() => window.addEventListener("pointerdown", onDown), 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [span, onClose]);

  const instants = useMemo(() => {
    if (span === null) return null;
    const date = parseIsoDate(span.dayIso);
    const from = timeToMinutes(startTime);
    const to = timeToMinutes(endTime);
    if (date === null || from === null || to === null || to <= from) return null;
    return {
      startsAt: zonedTimeToUtc(date, from, timeZone).toISOString(),
      endsAt: zonedTimeToUtc(date, to, timeZone).toISOString(),
    };
  }, [span, startTime, endTime, timeZone]);

  if (span === null || anchor === null) return null;

  const { left, top } = place(anchor);

  return (
    <div
      ref={card}
      role="dialog"
      aria-label="New appointment"
      className="fixed z-50 rounded-xl border border-[var(--hairline)] bg-[var(--surface-solid)] shadow-2xl"
      style={{ left, top, width: CARD_WIDTH }}
    >
      <div className="flex justify-end px-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-[var(--ink-3)] hover:bg-[var(--surface-2)] hover:text-[var(--ink-1)]"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>

      <form action={action} className="flex flex-col gap-3 px-4 pb-4">
        <input type="hidden" name="calendarId" value={calendarId} />
        <input type="hidden" name="status" value="booked" />
        <input type="hidden" name="startsAt" value={instants?.startsAt ?? ""} />
        <input type="hidden" name="endsAt" value={instants?.endsAt ?? ""} />
        <input type="hidden" name="title" value={title} />

        {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}

        <input
          /* Focused on open: the card exists to name the thing, and Save is one key away. */
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Add title"
          aria-label="Title"
          maxLength={200}
          className="border-b border-[var(--hairline)] bg-transparent pb-1.5 text-[16px] font-medium outline-none placeholder:text-[var(--ink-3)] focus:border-[var(--accent)]"
        />

        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-[var(--ink-2)]">
          <span className="shrink-0 tabular-nums whitespace-nowrap">{span.dayIso}</span>
          <div className="w-[104px]">
            <TimeSelect label="From" hideLabel value={startTime} onChange={setStartTime} />
          </div>
          <span aria-hidden>–</span>
          <div className="w-[104px]">
            <TimeSelect label="To" hideLabel value={endTime} onChange={setEndTime} />
          </div>
        </div>

        {instants === null && (
          <p className="text-[12px] text-[var(--bad)]">An appointment has to end after it starts.</p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            onClick={() => onMoreOptions({ ...span, startMinute: span.startMinute, endMinute: span.endMinute })}
            disabled={pending}
          >
            More options
          </Button>
          <Button variant="primary" size="sm" type="submit" disabled={pending || instants === null}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
};
