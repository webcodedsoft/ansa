import type { Tone } from "@/components/ui";

/**
 * What a call came to, in words a person running a business would use.
 *
 * `end_reason` holds two different kinds of thing in one column. Some values are outcomes —
 * `completed`, `no-answer`, `escalated` — and some are the transport saying how the socket
 * closed: `carrier sent stop`, `socket closed with code 1005`. The second kind is real to an
 * engineer reading a call that went wrong and noise to everybody else; a receptionist looking
 * at "socket closed with code 1005" beside a caller's name learns nothing and wonders whether
 * something is broken.
 *
 * So this is the one place the column is turned into a label, and every screen goes through
 * it. The raw value is not lost — the call page keeps it in the event log behind a `<details>`,
 * which is where evaluation happens — it is just not the first thing anybody sees.
 *
 * Only the reasons the API actually writes are mapped; anything unrecognised is "ended" rather
 * than guessed at, because a new reason nobody has looked at yet is exactly the kind of string
 * that should not be shown to a customer's staff verbatim.
 */
/**
 * Which glyph goes with the label. A name rather than a component, so this file stays a pure
 * mapping a test can import without React; `OutcomeTag` turns the name into the drawing.
 */
export type OutcomeIcon =
  | "live"
  | "done"
  | "human"
  | "forwarded"
  | "missed"
  | "busy"
  | "voicemail"
  | "failed"
  | "hung-up"
  | "ended";

export interface Outcome {
  readonly label: string;
  readonly tone: Tone;
  readonly icon: OutcomeIcon;
}

const KNOWN: Readonly<Record<string, Outcome>> = {
  completed: { label: "completed", tone: "ok", icon: "done" },
  /* Both mean a person took over, and both are worth noticing — but not as failures. A
     handover is the product doing the right thing with a call it could not finish. */
  escalated: { label: "handed to a human", tone: "warn", icon: "human" },
  transferred: { label: "transferred", tone: "warn", icon: "forwarded" },
  "no-answer": { label: "no answer", tone: "warn", icon: "missed" },
  busy: { label: "busy", tone: "warn", icon: "busy" },
  voicemail: { label: "voicemail", tone: "bad", icon: "voicemail" },
  failed: { label: "failed", tone: "bad", icon: "failed" },
  /* Plain English already, and deliberately neutral: people hang up when they are finished,
     and painting that amber would teach everyone to ignore amber. */
  "caller hung up": { label: "caller hung up", tone: "neutral", icon: "hung-up" },
};

/**
 * Everything else — `carrier sent stop`, `socket closed with code 1005`, whatever the next
 * transport writes — means only that the call is over. Which one you got says more about the
 * socket than about the person, so they all read the same.
 */
const ENDED: Outcome = { label: "ended", tone: "neutral", icon: "ended" };

export const outcomeOf = (endReason: string | null, ended: boolean): Outcome => {
  if (!ended) return { label: "live", tone: "accent", icon: "live" };
  if (endReason === null) return ENDED;
  return KNOWN[endReason] ?? ENDED;
};

/**
 * The reasons a person can filter by, with what each is called on screen.
 *
 * The filter sends the raw value because that is what the API matches on; the option text is
 * the label so the menu and the column agree. The transport exits are not offered — filtering
 * by "socket closed with code 1005" is an evaluation question, and the call page's event log
 * is where that gets asked.
 */
export const FILTERABLE_OUTCOMES: readonly { readonly value: string; readonly label: string }[] =
  Object.entries(KNOWN).map(([value, outcome]) => ({ value, label: outcome.label }));
