import { watMoment, type BusinessHours } from "@ansa/shared";

import type { ToolArgs, ToolDefinition } from "../types";
import type { InternalHandler, InternalTool } from "./adapter";

/**
 * The platform's own tools: the three things the agent can do that need no organization data.
 *
 * They are deliberately the only tools registered today. Anything that answers a question
 * about a caller's account needs a real system behind it, and an agent answering
 * confidently from a fixture nobody wrote is worse than one that says it cannot check.
 * `internal/policy.ts` is that fixture and it is for tests.
 *
 * Two of the three are effects on the call rather than lookups, which is why this file
 * takes callbacks instead of a data source. Neither of them performs the effect here:
 * ending a call and transferring one both have to happen after the caller has HEARD
 * something, and only the orchestrator knows when a sentence has been heard.
 */

export interface CallControlOptions {
  /**
   * The caller is finished and the line should close.
   *
   * Must not hang up immediately. Queued audio sits at the carrier for over a second on a
   * real call — measured on this project's own — so hanging up when the tool returns cuts
   * the goodbye off mid-word. The implementation waits for the mark.
   */
  readonly endCall: (reason: string) => void;
  /**
   * The model answering a question on the caller's behalf.
   *
   * For the questions the capture engine cannot hear — a choice between listed answers, or
   * free text. The engine hears values with a shape; "I'd like to rent, I think" has none,
   * and only the model can say it was `rent`. The orchestrator owns the check: whether the
   * key is such a question on this agent, and whether the answer is one of its options. Not
   * a callback with a default, because a default that refused everything would ship a tool
   * that the model is told to use and that never works.
   */
  readonly recordAnswer: (field: string, answer: string) => RecordedAnswer;
  /** Null when this organization has never configured any. The tool then says so. */
  readonly businessHours: BusinessHours | null;
  /** Overridden in tests. */
  readonly now?: () => Date;
}

/** What the orchestrator says back when the model records an answer. */
export type RecordedAnswer =
  | { readonly accepted: true; readonly field: string; readonly answer: string }
  /** `reason` is what the model is told, so it can ask again or pick a listed option. */
  | { readonly accepted: false; readonly reason: string };

/* ------------------------------------------------------------------ hours */

/** ISO weekday order, so index 0 is Monday. */
const DAY_NAMES: readonly string[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const DAYS_IN_WEEK = 7;

/**
 * Configuration is a database row, so it is input rather than data.
 *
 * Null for anything that cannot be reasoned about, and the tool then answers "I do not
 * have them" — which is true, and is the only answer that does not risk telling a caller
 * the line is closed when it is open. An overnight window is refused rather than
 * guessed at: `opensAtHour: 22, closesAtHour: 2` could mean a night shift or a typo, and
 * the two produce opposite answers.
 */
const usableHours = (hours: BusinessHours | null): BusinessHours | null => {
  if (hours === null) return null;

  const { opensAtHour: opens, closesAtHour: closes } = hours;
  const whole = (n: number): boolean => Number.isInteger(n);
  if (!whole(opens) || !whole(closes)) return null;
  if (opens < 0 || opens > 23) return null;
  if (closes < 1 || closes > 24) return null;
  if (opens >= closes) return null;

  const days = [...new Set(hours.openDays)].filter((d) => whole(d) && d >= 1 && d <= DAYS_IN_WEEK);
  if (days.length === 0) return null;

  return { opensAtHour: opens, closesAtHour: closes, openDays: days.sort((a, b) => a - b) };
};

/**
 * "9:00 am", and never "12:00 am".
 *
 * Midnight and noon are named because the twelve-hour clock cannot say them without
 * being ambiguous, and this sentence is read to someone deciding whether to ring back.
 */
const clockFace = (hour: number): string => {
  if (hour === 0 || hour === 24) return "midnight";
  if (hour === 12) return "noon";
  const half = hour < 12 ? "am" : "pm";
  return `${String(hour % 12)}:00 ${half}`;
};

/** How the caller would refer to a day that is `ahead` days from today. */
const dayPhrase = (weekday: number, ahead: number): string => {
  if (ahead === 0) return "today";
  if (ahead === 1) return "tomorrow";
  return `on ${DAY_NAMES[weekday - 1] ?? "that day"}`;
};

/** What the handler produces. Turned into a sentence by `summarise`, never spoken raw. */
export type HoursAnswer =
  | { readonly known: false }
  | {
      readonly known: true;
      readonly open: true;
      /** WAT hour the line closes today. */
      readonly closesAtHour: number;
    }
  | {
      readonly known: true;
      readonly open: false;
      /** Null when the configured days somehow never come round again. */
      readonly next: { readonly hour: number; readonly weekday: number; readonly ahead: number } | null;
    };

/**
 * The next moment the line is open, searched forward a week from now.
 *
 * A week is exhaustive: `openDays` is a set of weekdays, so if none of the next seven
 * days is open, none ever is.
 */
const nextOpening = (
  hours: BusinessHours,
  from: { readonly hour: number; readonly weekday: number },
): { readonly hour: number; readonly weekday: number; readonly ahead: number } | null => {
  for (let ahead = 0; ahead <= DAYS_IN_WEEK; ahead += 1) {
    const weekday = ((from.weekday - 1 + ahead) % DAYS_IN_WEEK) + 1;
    if (!hours.openDays.includes(weekday)) continue;
    // Today only counts if opening is still to come; otherwise the line has closed for
    // the day and the caller wants the next one.
    if (ahead === 0 && from.hour >= hours.opensAtHour) continue;
    return { hour: hours.opensAtHour, weekday, ahead };
  }
  return null;
};

export const answerHours = (hours: BusinessHours | null, now: Date): HoursAnswer => {
  const usable = usableHours(hours);
  if (usable === null) return { known: false };

  const moment = watMoment(now);
  const openToday = usable.openDays.includes(moment.weekday);
  if (openToday && moment.hour >= usable.opensAtHour && moment.hour < usable.closesAtHour) {
    return { known: true, open: true, closesAtHour: usable.closesAtHour };
  }

  return { known: true, open: false, next: nextOpening(usable, moment) };
};

const isHoursAnswer = (value: unknown): value is HoursAnswer =>
  value !== null && typeof value === "object" && "known" in value;

const sayHours = (answer: HoursAnswer): string => {
  if (!answer.known) {
    // Honest rather than helpful, and deliberately so. Inventing plausible office hours
    // is the same failure as answering from a policy book nobody wrote.
    return "I do not have the opening hours on file, so I cannot say for certain.";
  }
  if (answer.open) {
    return `We are open now, until ${clockFace(answer.closesAtHour)} today.`;
  }
  if (answer.next === null) return "We are closed at the moment.";
  return `We are closed at the moment. We open again ${dayPhrase(answer.next.weekday, answer.next.ahead)} at ${clockFace(answer.next.hour)}.`;
};

/* ------------------------------------------------------------------ definitions */

/**
 * A free-text reason from the model, if it gave one. Logged, never spoken.
 *
 * Absent is not an error: the reason is for whoever reads the call back, and refusing to
 * end a call because the model did not annotate it would be a worse trade than a thin
 * log line.
 */
const reasonFrom = (args: ToolArgs): string => {
  const value = args.reason;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "the model asked";
};

const REASON_PARAMETER = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      description: "One short clause saying why, for the call record. Not spoken to the caller.",
    },
  },
} as const;

/**
 * `end_call` is read tier, and that is a decision rather than an oversight.
 *
 * The tiers grade what a tool does to the organization's records: `write` earns a readback
 * because a wrong value gets stored, `irreversible` earns a person because nothing can
 * undo it. Ending a call stores nothing and is undone by dialling again. Putting it
 * behind a spoken confirmation would mean answering "goodbye" with "are you sure?",
 * which is friction aimed at the one caller who is already leaving happy.
 */
const END_CALL: ToolDefinition = {
  name: "end_call",
  description:
    "End the call. Use only when the caller has said they are done and there is nothing left to help with.",
  parameters: REASON_PARAMETER,
  riskTier: "read",
  summarise: () => "The call will end once you have said goodbye.",
};

/**
 * `transfer_to_human` is irreversible tier, and the tier IS the implementation.
 *
 * The rule reads "irreversible — never executes, transfers to a human", which looks like a
 * contradiction for a tool whose entire purpose is to transfer to a human. It is not, and
 * the resolution is worth stating plainly because the alternative is a second transfer
 * path:
 *
 *   - "never executes" is about the adapter. This tool has no adapter work to skip — the
 *     handler below is a tripwire that throws, exactly like `cancel_policy`, so if the
 *     dispatcher ever lets an irreversible tool through it says so instead of doing
 *     something quietly.
 *   - "transfers to a human" is what the dispatcher's irreversible branch already returns:
 *     a `transfer` outcome carrying `transferReason`. The orchestrator routes that into
 *     `apps/api/src/handoff/`, which is the one place that speaks the departure line, waits
 *     for the caller to hear it, whispers the summary to whoever picks up, and apologises
 *     out loud if the carrier refuses.
 *
 * So the tool is registered at the tier whose built-in behaviour is precisely what the
 * tool means. Registering it lower — `read`, with an adapter that dials — would put a
 * second transfer implementation beside the handoff module, and the two would answer
 * "what does the caller hear when the transfer fails" differently within a month.
 */
const TRANSFER_TO_HUMAN: ToolDefinition = {
  name: "transfer_to_human",
  description:
    "Hand the call to a person. Use when the caller asks for one, or when what they need is beyond you.",
  parameters: REASON_PARAMETER,
  riskTier: "irreversible",
  transferReason: "the assistant asked for a person",
};

/**
 * The escape hatch for a call that has stopped being about what they rang for.
 *
 * Separate from `transfer_to_human` because the model is the only thing on the call that
 * can recognise this, and because the two go to different places: an office line that
 * keeps hours, and a line that does not. Detecting distress in code was considered and
 * rejected — a regular expression over a transcript would both miss the real thing and
 * fire on somebody quoting a film, and the cost of each mistake is not symmetrical.
 *
 * Irreversible tier for the same reason `transfer_to_human` is: the tier's own behaviour —
 * refuse, and hand to a person — is exactly what the tool means.
 */
const TRANSFER_URGENTLY: ToolDefinition = {
  name: "transfer_urgently",
  description:
    "Hand the call to a person immediately, at any hour, because the caller may be at risk " +
    "of harm. Use only for that. Everything else, including anger and abuse, is transfer_to_human.",
  parameters: REASON_PARAMETER,
  riskTier: "irreversible",
  transferReason: "the caller may be at risk",
};

const ANSWER_PARAMETERS = {
  type: "object",
  properties: {
    field: {
      type: "string",
      description: "The field name of the question, exactly as it appears in your instructions.",
    },
    answer: {
      type: "string",
      description:
        "What they chose. For a question with listed answers, exactly one of the listed answers.",
    },
  },
  required: ["field", "answer"],
} as const;

/**
 * `record_answer` is read tier, and the value it stores is marked unconfirmed.
 *
 * It writes to the call's own record, not to the organisation's systems, and the value is
 * the caller's stated preference rather than an identifier — nothing downstream fires on it
 * without a person's say-so, because a write-tier tool refuses an unconfirmed value and that
 * gate is not configurable. A spoken readback of "you said rent" before recording it would
 * be the readback rule applied to the one kind of answer that does not need it.
 */
const RECORD_ANSWER: ToolDefinition = {
  name: "record_answer",
  description:
    "Record the caller's answer to one of the choice or free-text questions in your instructions. " +
    "Only for those: names, numbers and identifiers are heard and confirmed for you. " +
    "For a question with listed answers, record exactly one of the listed answers.",
  parameters: ANSWER_PARAMETERS,
  riskTier: "read",
  summarise: (result) => {
    const recorded = result as RecordedAnswer;
    return recorded.accepted
      ? `Recorded ${recorded.field}: ${recorded.answer}.`
      : `Not recorded: ${recorded.reason}`;
  },
};

const BUSINESS_HOURS: ToolDefinition = {
  name: "business_hours",
  description: "Check whether the office is open right now, and when it next opens.",
  parameters: { type: "object", properties: {} },
  riskTier: "read",
  summarise: (result) =>
    isHoursAnswer(result) ? sayHours(result) : sayHours({ known: false }),
};

/**
 * Every platform tool, definition only.
 *
 * Exported so the prompt's task layer can list exactly what is registered without
 * building a registry. The list is the single source of which tools exist: `callControlTools`
 * below is built from it, so a tool cannot be offered to the model and then be missing
 * from the registry, or the other way round.
 */
export const CALL_CONTROL_DEFINITIONS: readonly ToolDefinition[] = [
  END_CALL,
  TRANSFER_TO_HUMAN,
  TRANSFER_URGENTLY,
  BUSINESS_HOURS,
  RECORD_ANSWER,
];

const handlersFor = (options: CallControlOptions): Readonly<Record<string, InternalHandler>> => {
  const now = options.now ?? ((): Date => new Date());

  return {
    [END_CALL.name]: async ({ args }) => {
      options.endCall(reasonFrom(args));
      return { ending: true };
    },

    // Never reached: the dispatcher refuses an irreversible tool before any adapter runs.
    // Left as a tripwire rather than a no-op, so a regression in tier enforcement is a
    // loud failure rather than a call that quietly transfers itself without a departure
    // line or a whisper.
    [TRANSFER_TO_HUMAN.name]: async () => {
      throw new Error("transfer_to_human must never execute — the handoff module owns the transfer");
    },

    // Same tripwire, and it matters more here: this one reaches a line that answers at any
    // hour, and a tier regression that let it run would dial nobody while a caller who
    // needs somebody waits.
    [TRANSFER_URGENTLY.name]: async () => {
      throw new Error("transfer_urgently must never execute — the handoff module owns the transfer");
    },

    // No lookup, so no organization scoping to get wrong: the hours were resolved for this call
    // from this call's organization configuration before the registry was built.
    [BUSINESS_HOURS.name]: async () => answerHours(options.businessHours, now()),

    [RECORD_ANSWER.name]: async ({ args }) => {
      const field = typeof args["field"] === "string" ? args["field"].trim() : "";
      const answer = typeof args["answer"] === "string" ? args["answer"].trim() : "";
      if (field === "" || answer === "") {
        return { accepted: false, reason: "both the field and the answer are needed" } satisfies RecordedAnswer;
      }
      return options.recordAnswer(field, answer);
    },
  };
};

/**
 * The platform tools, ready to register.
 *
 * Built per call rather than per process, because two of the three close over this call's
 * own effects. That is the same reason the dispatcher is per call, and it costs three map
 * writes.
 */
export const callControlTools = (options: CallControlOptions): readonly InternalTool[] => {
  const handlers = handlersFor(options);

  return CALL_CONTROL_DEFINITIONS.map((definition) => {
    const handler = handlers[definition.name];
    if (handler === undefined) {
      // At construction, not mid-call. A definition with no handler would otherwise be
      // offered to the model and fail the first time a caller needed it.
      throw new Error(`no handler for platform tool ${definition.name}`);
    }
    return { definition, handler };
  });
};
