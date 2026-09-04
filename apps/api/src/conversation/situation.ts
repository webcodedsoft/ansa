import type { CallerHistory } from "@ansa/db";
import { watMoment, type BusinessHours } from "@ansa/shared";

/**
 * Where the call is, as opposed to what the caller has said.
 *
 * `facts-prompt.ts` renders what the caller told us, and is careful about it — an
 * unconfirmed name never appears as a value there. Nothing here came from the caller. It
 * is the clock, the organisation's opening hours, and two counters this process has been
 * keeping anyway, so none of that discipline applies, and mixing the two would blur it.
 *
 * **Every field is computed here and none of it is asked of the model.** An agent left to
 * work out whether half past four on a Friday is near closing will get it wrong, and will
 * get it wrong differently each turn. Booleans and formatted strings go into the prompt;
 * no date arithmetic leaves this file.
 *
 * Pure. `now` is a parameter rather than `Date.now()`, so a test can stand at four o'clock
 * on a Friday without waiting for one.
 *
 * The one thing here that did not come free is `history`, which is a database read. It is
 * taken once as the call connects, while the greeting plays, and arrives as a value rather
 * than a promise: null means it has not landed yet or there was nothing to land, and the
 * block simply says nothing. **No turn ever waits for it.** That is the two-loop rule, and
 * it is why this stays a pure function over whatever happens to be in hand.
 */

export type PartOfDay = "morning" | "afternoon" | "evening" | "night";

export interface SituationInput {
  readonly now: Date;
  /** `Date.now()` when the media stream opened. */
  readonly callStartedAtMs: number;
  /** Null until the organisation configures them. Null means say nothing, never guess. */
  readonly businessHours: BusinessHours | null;
  /**
   * Turns that went nowhere, from the escalation watch's own counter.
   *
   * The same number the hard rule counts to three on. Showing it lets the agent give up
   * gracefully at two rather than being cut off at three, which is the difference between
   * "let me get someone who can help" and a transfer landing mid-sentence.
   */
  readonly failedTurns: number;
  /** True once a transfer has been triggered. Nothing should offer a person twice. */
  readonly escalationOffered: boolean;
  /**
   * The transcriber was not sure of the caller's last turn.
   *
   * This value has always existed — the transcriber reports a confidence with every final
   * — and it reached the capture engine, which shortens its attempts on it, and stopped
   * there. The model was told to assume a nonsensical word was misheard and answer the
   * sensible reading, and was never told when the whole turn was doubtful. So it guessed,
   * confidently, on the turns where it should have asked.
   */
  readonly lastTurnUnclear: boolean;
  /**
   * What this number has done before, or null when it is not known.
   *
   * Null covers three cases the block treats identically — a withheld number, a deployment
   * with no database, and a read that has not come back yet — because the agent's correct
   * behaviour is the same in all three: say nothing and treat them as new.
   */
  readonly history: CallerHistory | null;
}

export interface Situation {
  readonly lastTurnUnclear: boolean;
  readonly partOfDay: PartOfDay;
  /** 24-hour WAT, for the model to read rather than to say. */
  readonly localTime: string;
  readonly weekday: string;
  /**
   * Today, spelled out, in WAT.
   *
   * The agent had the hour and the weekday and no date at all, so it could not answer
   * "what's today's date" and could not work out "three days from now" — it would have had
   * to guess the year. Anything a caller says about a date is measured from this.
   */
  readonly today: string;
  /** Null when the organisation has configured no hours. */
  readonly openNow: boolean | null;
  /** Minutes until the line closes, or null when it is shut or the hours are unknown. */
  readonly closesInMinutes: number | null;
  readonly minutesElapsed: number;
  readonly failedTurns: number;
  readonly escalationOffered: boolean;
  readonly history: CallerHistory | null;
}

/** Indexed from 1 to match `WatMoment.month`, so slot 0 is never read. */
const MONTHS: readonly string[] = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** ISO weekday, 1 is Monday. Indexed from 1, so slot 0 is never read. */
const WEEKDAYS: readonly string[] = [
  "",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/**
 * Boundaries chosen for how a working day is spoken about rather than for symmetry.
 * Evening starts at five because that is when a line typically shuts and the caller is
 * ringing after work; night starts at nine because past that an agent should sound like it
 * knows the hour.
 */
const partOfDayAt = (hour: number): PartOfDay => {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "night";
};

const twoDigits = (value: number): string => String(value).padStart(2, "0");

export const describeSituation = (input: SituationInput): Situation => {
  const moment = watMoment(input.now);
  const hours = input.businessHours;

  /* `closesAtHour` is exclusive — a line that shuts at five holds 17 — so "open" is
     `hour < closesAtHour`, and the minutes remaining count to the top of that hour. */
  const openToday = hours !== null && hours.openDays.includes(moment.weekday);
  const openNow =
    hours === null
      ? null
      : openToday && moment.hour >= hours.opensAtHour && moment.hour < hours.closesAtHour;

  const closesInMinutes =
    hours === null || openNow !== true
      ? null
      : (hours.closesAtHour - moment.hour) * 60 - moment.minute;

  return {
    partOfDay: partOfDayAt(moment.hour),
    localTime: `${twoDigits(moment.hour)}:${twoDigits(moment.minute)}`,
    weekday: WEEKDAYS[moment.weekday] ?? "",
    today: `${WEEKDAYS[moment.weekday] ?? ""} ${moment.day} ${MONTHS[moment.month] ?? ""} ${moment.year}`.trim(),
    openNow,
    closesInMinutes,
    /* Floored. A call forty seconds old is nought minutes old, and rounding up to one
       would have the agent behaving as though the caller had been waiting. */
    minutesElapsed: Math.max(0, Math.floor((input.now.getTime() - input.callStartedAtMs) / 60_000)),
    failedTurns: input.failedTurns,
    lastTurnUnclear: input.lastTurnUnclear,
    escalationOffered: input.escalationOffered,
    history: input.history,
  };
};

const HEADER = "Where this call is right now. All of it is worked out for you.";

/** Under an hour is where "we can't finish that today" starts being true. */
const CLOSING_SOON_MINUTES = 60;
/** Past this a caller is invested and getting impatient. See the prompt's CALL LENGTH rule. */
const LONG_CALL_MINUTES = 4;

/**
 * Only when the hours change what the agent should do.
 *
 * There is no "the line is open" line, and that is the correction the tests forced. Open
 * is the default the prompt is already written against — offer a transfer, promise things
 * for today — so saying it every turn tells the model something it was going to assume
 * anyway, and it made the whole block unconditional during office hours. Silence here
 * means "carry on"; a line here means the default is wrong.
 */
const hoursLines = (situation: Situation): readonly string[] => {
  /* Nothing at all when the organisation configured no hours. An agent that says "we're
     open" on a guess is worse than one that never raises it. */
  if (situation.openNow === null) return [];
  if (!situation.openNow) {
    return ["- The line is closed right now. Do not promise anything for today."];
  }
  const closing = situation.closesInMinutes;
  if (closing === null || closing > CLOSING_SOON_MINUTES) return [];
  return [
    `- The line closes in ${closing} minutes. Do not start anything that cannot finish before then — say so and offer the alternative instead.`,
  ];
};

const lengthLines = (situation: Situation): readonly string[] =>
  situation.minutesElapsed < LONG_CALL_MINUTES
    ? []
    : [
        `- This call has been running ${situation.minutesElapsed} minutes. Stop gathering and start resolving. If it is not close, offer them a person.`,
      ];

const escalationLines = (situation: Situation): readonly string[] => {
  if (situation.escalationOffered) {
    // Offering twice reads as not having listened the first time.
    return ["- You have already offered them a person. Do not offer again."];
  }
  if (situation.failedTurns === 0) return [];
  const turns =
    situation.failedTurns === 1 ? "One turn has" : `${situation.failedTurns} turns have`;
  return [
    `- ${turns} gone nowhere on this call. Change approach, or offer them a person — do not try the same thing again.`,
  ];
};

/**
 * A caller who has rung this many times in a week is not going to be helped by a fourth
 * attempt at the same thing. Three contacts means the process failed, not the caller.
 */
const TOO_MANY_CONTACTS = 3;

const whenTheyLastRang = (days: number): string => {
  if (days === 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days <= 7) return `${days} days ago`;
  return "a while back";
};

/**
 * What we already know about them, and what to do about it.
 *
 * The strongest line in the block, and the one worth getting right: opening as though a
 * caller is new when they rang yesterday about the same thing is the complaint people
 * actually make about these systems. Every line here is a fact from the call log with an
 * instruction attached — never a guess about what the previous call was about, because
 * nothing on disk knows that.
 */
const historyLines = (situation: Situation): readonly string[] => {
  const history = situation.history;
  // Not known, not known yet, or a withheld number. Treat them as new; say nothing.
  if (history === null || history.lastContactDaysAgo === null) return [];

  const lines = [
    `- They called before, ${whenTheyLastRang(history.lastContactDaysAgo)}. Do not greet them as a new caller and do not make them explain it again from the start.`,
  ];

  if (history.lastCallAbout !== null) {
    /* Their own words, quoted, with the model told plainly that they are approximate. The
       comment below is right that an agent told "their issue is unresolved" invents the
       issue — the fix is not silence but attribution: the difference between "you were
       asking about the delivery" and inventing a delivery is whether the sentence came
       from the caller or from the model. Quoting makes that visible, and 8kHz transcripts
       are wrong often enough that it must never be repeated as fact. */
    lines.push(
      `- Last time they opened with "${history.lastCallAbout}". That is a rough transcript, so use it to avoid making them start over, never as something you know.`,
    );
  }

  if (history.knownAs !== null) {
    /* A number is a phone, not a person. The name is offered as something to check, in the
       words a person would use — and the model is told what not to do with it, because the
       obvious move, "Welcome back, Adaeze!", is the one that goes wrong on a shared phone. */
    lines.push(
      `- Somebody calling from this number before gave the name "${history.knownAs}". It may be them or somebody else on the same phone: check — "is that ${history.knownAs}?" — and use it once they say so. Never open with it as though you know who is calling.`,
    );
  }

  if (history.lastCallHandedOver) {
    /* A handover is a fact; what it was about is not, so the line says only what is known.
       An agent told "their last issue is unresolved" will invent the issue. */
    lines.push(
      "- That call ended with a person taking over. Whatever it was, this line could not finish it.",
    );
  }

  if (history.contactsThisWeek >= TOO_MANY_CONTACTS) {
    lines.push(
      `- This is their ${history.contactsThisWeek + 1}th call this week. Do not try to solve it yourself — get them to a person now.`,
    );
  }

  return lines;
};

/**
 * The block, or an empty string when there is nothing worth saying.
 *
 * Empty is a real answer and the common one two turns into a call in office hours: the
 * time is unremarkable, nothing has failed, and a paragraph saying so costs prompt budget
 * every turn while teaching the model nothing.
 */
export const renderSituation = (situation: Situation): string => {
  const lines = [
    `- Today is ${situation.today}. It is ${situation.localTime} ${
      situation.partOfDay === "night" ? "at night" : `in the ${situation.partOfDay}`
    }, where they are. Work every date the caller mentions out from this one.`,
    ...hoursLines(situation),
    ...historyLines(situation),
    ...lengthLines(situation),
    ...escalationLines(situation),
    ...(situation.lastTurnUnclear
      ? [
          "- Their last turn came through unclearly. If what they said changes what you do next, check it with one short question rather than guessing. If it doesn't matter, carry on.",
        ]
      : []),
  ];

  /* The clock line used to be suppressed on its own, because by itself it mostly invited
     "good afternoon!" as an opener. It now carries the date, which the agent cannot work
     out from anything else and needs the moment a caller says "next Tuesday" — so it is
     always sent, and the greeting problem is handled where it belongs: `conversation.ts`
     opens with "your greeting has already been spoken, don't greet them again". */

  return [HEADER, "", ...lines].join("\n");
};
