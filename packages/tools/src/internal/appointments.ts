import type { ToolDefinition } from "../types";

/**
 * Taking an appointment on a call.
 *
 * The diary has been reachable from the console since 0062 and unreachable from a call ever
 * since: the hours an operator set were offered to nobody, and every design note in that slice
 * — the held state, `holdMinutes`, `SlotTaken`, the holiday guard — was written for a caller
 * on the phone who could not get to it. These two tools are that path.
 *
 * **Two tools rather than one.** Offering times and taking one are different acts with
 * different risk: looking at a diary changes nothing, and committing a chair changes something
 * the caller is agreeing to. Fusing them would force the whole thing to the higher tier and a
 * caller asking "what have you got on Thursday?" would be read a confirmation.
 *
 * **`book_appointment` is `write`, which has two consequences worth stating.**
 *
 * It earns a spoken readback before it fires — the dispatcher issues one and will not execute
 * until the caller says yes. That is the whole reason the tier exists, and booking is the
 * clearest case for it: an 8kHz line, a spoken date, and a chair somebody has to turn up to.
 *
 * And it does not run on outbound calls at all. The dispatcher refuses every write tool there,
 * because the person did not ring us and cannot verify who they are agreeing with. That rule
 * is not being worked around here: an outbound campaign that wants to move an appointment
 * should get a human on the line, and a call that talks somebody into a booking they did not
 * seek is the thing the rule exists to prevent.
 */

/** What a slot looks like coming back, in the shape the model has to echo to book it. */
export interface OfferedSlot {
  /** The instant, exactly as it must be passed back to `book_appointment`. */
  readonly startsAt: string;
  /** How to say it out loud, in the calendar's own zone. */
  readonly spoken: string;
}

export type SlotsAnswer =
  | { readonly known: true; readonly slots: readonly OfferedSlot[] }
  | { readonly known: false; readonly reason: string };

export type BookingAnswer =
  | { readonly booked: true; readonly spoken: string }
  | { readonly booked: false; readonly reason: string };

const SLOTS_PARAMETERS = {
  type: "object",
  properties: {
    day: {
      type: "string",
      description:
        "A single day to look at, as YYYY-MM-DD. Leave it out to be offered the next few " +
        "available times, whenever they are.",
    },
  },
  required: [],
} as const;

const BOOK_PARAMETERS = {
  type: "object",
  properties: {
    startsAt: {
      type: "string",
      description:
        "The exact startsAt value of one of the slots you were just offered, copied back " +
        "unchanged. Never a time you composed yourself.",
    },
    name: {
      type: "string",
      description: "Who the appointment is for, if they gave a name. Optional.",
    },
  },
  required: ["startsAt"],
} as const;

/**
 * The times on offer.
 *
 * `read` tier: looking at a diary changes nothing, and a caller asking what is free should
 * never be read a confirmation to hear the answer.
 */
export const FIND_SLOTS = {
  name: "find_appointment_slots",
  description:
    "Find appointment times that are actually free. Offer two or three of them out loud, " +
    "never the whole list, and only ever times this returns.",
  parameters: SLOTS_PARAMETERS,
  riskTier: "read",
  summarise: (result) => {
    const answer = result as SlotsAnswer;
    if (!answer.known) return `No times could be looked up: ${answer.reason}`;
    if (answer.slots.length === 0) return "There is nothing free then.";
    /* Three at most, and it is a speech decision rather than a data one: a list of nine times
       read down a phone is a list nobody remembers the start of. */
    const few = answer.slots.slice(0, 3).map((slot) => slot.spoken);
    return `Free: ${few.join(", ")}.`;
  },
} satisfies ToolDefinition;

/**
 * Taking one.
 *
 * `write`, so the dispatcher reads the time back and waits for a spoken yes. The readback is
 * the whole point on an 8kHz line: "Tuesday at two" and "Thursday at two" are one consonant
 * apart, and a chair is something somebody has to travel to.
 */
export const BOOK_APPOINTMENT = {
  name: "book_appointment",
  description:
    "Take one of the times you offered. Pass back the exact startsAt you were given. " +
    "The caller will be read the time and asked to confirm before anything is booked.",
  parameters: BOOK_PARAMETERS,
  riskTier: "write",
  readback: (args) => {
    const spoken = typeof args["spoken"] === "string" ? args["spoken"] : null;
    const startsAt = typeof args["startsAt"] === "string" ? args["startsAt"] : "";
    /* The model is asked for the instant, not the words, so the words are rebuilt here from
       what it echoed. A readback that said the raw instant out loud would be worse than none:
       nobody agrees to "2026-03-03T14:00:00+01:00". */
    return `Shall I book ${spoken ?? sayInstant(startsAt)}?`;
  },
  summarise: (result) => {
    const answer = result as BookingAnswer;
    return answer.booked ? `Booked ${answer.spoken}.` : `Not booked: ${answer.reason}`;
  },
} satisfies ToolDefinition;

/**
 * An instant, said the way a person says it.
 *
 * A fallback for the readback when the offer's own wording is not to hand. It reads the offset
 * the instant carries rather than converting — the slots this books came from
 * `toOffsetIso`, so the offset in the string is already the calendar's own.
 */
export const sayInstant = (iso: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (match === null) return "that time";
  const [, , month, day, hour, minute] = match;
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const hour24 = Number(hour);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const clock = minute === "00" ? `${hour12}` : `${hour12}:${minute}`;
  return `${Number(day)} ${months[Number(month) - 1] ?? ""} at ${clock}${hour24 < 12 ? "am" : "pm"}`;
};

export const APPOINTMENT_DEFINITIONS: readonly ToolDefinition[] = [FIND_SLOTS, BOOK_APPOINTMENT];

/**
 * What the handlers need from the call.
 *
 * Deliberately not a database handle. This package knows nothing about Postgres and should
 * keep it that way — the gateway, which already holds a scoped connection for this call's
 * organisation, passes two functions and this decides nothing about tenancy. That is also
 * what makes these testable without standing a database up.
 */
export interface AppointmentToolOptions {
  /**
   * Whether this agent has a diary at all, which is the one gate both halves read.
   *
   * False registers nothing and lists nothing. That is the same shape `knowledgeTools`
   * uses and for the same reason: a tool the model can see but cannot use is a tool it
   * will offer the caller, and "let me book you in" followed by a refusal is worse than
   * never having raised it.
   */
  readonly hasCalendar: boolean;
  /** Free times, in the calendar's own zone, already filtered by hours, buffers and holidays. */
  readonly findSlots: (day: string | null) => Promise<readonly OfferedSlot[]>;
  /** Takes one. Returns why not, in words a caller can hear, when it could not. */
  readonly book: (startsAt: string, name: string | null) => Promise<BookingAnswer>;
}

/**
 * The definitions, when there are any.
 *
 * Exported for the same reason `CALL_CONTROL_DEFINITIONS` is: the prompt lists what is
 * registered without building a registry, and both come from this, so the model cannot be
 * offered a booking the dispatcher would refuse.
 */
export const appointmentDefinitions = (hasCalendar: boolean): readonly ToolDefinition[] =>
  hasCalendar ? APPOINTMENT_DEFINITIONS : [];

export const appointmentTools = (
  options: AppointmentToolOptions,
): readonly { definition: ToolDefinition; handler: (call: { args: Record<string, unknown> }) => Promise<unknown> }[] =>
  !options.hasCalendar ? [] : [
  {
    definition: FIND_SLOTS,
    handler: async ({ args }) => {
      const raw = typeof args["day"] === "string" ? args["day"].trim() : "";
      /* A day the model invented in the wrong shape is not a reason to fail the lookup: it
         falls back to "the next few times", which is what the caller asked for anyway. */
      const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
      const slots = await options.findSlots(day);
      return { known: true, slots } satisfies SlotsAnswer;
    },
  },
  {
    definition: BOOK_APPOINTMENT,
    handler: async ({ args }) => {
      const startsAt = typeof args["startsAt"] === "string" ? args["startsAt"].trim() : "";
      if (startsAt === "") {
        return { booked: false, reason: "no time was given" } satisfies BookingAnswer;
      }
      const name = typeof args["name"] === "string" && args["name"].trim() !== "" ? args["name"].trim() : null;
      return options.book(startsAt, name);
    },
  },
];
