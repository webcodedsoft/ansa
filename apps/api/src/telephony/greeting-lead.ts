import type { PartOfDay } from "../conversation/situation";

/**
 * The first half-second of a call, which is currently one recording.
 *
 * Everything about the pre-rendered greeting is right except that there is exactly one of
 * it. Synthesising per call costs a measured 959ms cold at the moment the caller is
 * listening hardest, so the cache stays — but the same file played to the same person
 * three times in a week is what makes an agent sound like a machine rather than like a
 * line somebody picks up.
 *
 * So: a short lead-in chosen per call, pre-rendered exactly as the greeting is, and spoken
 * before the operator's own words. The operator's greeting is never rewritten — their
 * brand line is theirs, and prefixing "Good morning" onto a greeting that already says
 * good morning is worse than any amount of sameness.
 *
 * **The brief's selection rule does not do what the brief says it does.** It asks for the
 * pick to be seeded from the caller's number "so the same caller gets a different variant
 * each time", and a hash of a number that never changes gives that caller the same variant
 * forever. The call id is the thing that varies between calls and holds still within one,
 * so that is what is hashed here.
 *
 * The returning-caller lead-in is the one that earns this. "Hi again" does more for how a
 * caller rates the whole call than any amount of tuning on the body of it — and its absence
 * is the complaint people actually make, which is being asked to explain the same thing to
 * the same company for the third time this week.
 *
 * It needs the caller's history before the first word, and that read used to start as the
 * media socket opened — a beat after the words it was meant to change. It now starts at
 * ingress, on the same terms as the audio render: never awaited, and collected by the
 * socket if it arrived. When it did not, the pools below behave exactly as they did.
 */

/**
 * Nothing at all is a member of every pool, and usually the right answer.
 *
 * A greeting that opens with a flourish every single time is its own kind of recording. An
 * empty lead-in is what every call did before this existed, and it should stay the most
 * common outcome.
 */
const NOTHING = "";

/**
 * Time-of-day openers, in the register of somebody picking up a phone rather than reading
 * a script. Short on purpose: this is spoken before the organisation's own greeting, and
 * two sentences of preamble is worse than none at all.
 */
const BY_PART_OF_DAY: Readonly<Record<PartOfDay, readonly string[]>> = {
  morning: [NOTHING, "Good morning.", "Morning.", "Hi, good morning."],
  afternoon: [NOTHING, "Good afternoon.", "Hi there.", "Afternoon."],
  evening: [NOTHING, "Good evening.", "Hi there.", "Evening."],
  /* Nobody says "good night" when answering a phone. What a caller at eleven at night
     needs to hear is that somebody picked up, so these acknowledge the hour by not
     naming it. */
  night: [NOTHING, "Hello.", "Hi there."],
};

/**
 * When the line is shut. Less a greeting variant than a different situation — the agent's
 * own words about the hours come later, and this only sets the tone for them.
 */
const OUT_OF_HOURS: readonly string[] = [NOTHING, "Hello.", "Hi there."];

/**
 * For somebody who has rung before, recently.
 *
 * No blank in this pool, and that is the one place this file spends its variety budget: a
 * returning caller greeted identically to a stranger is the failure the whole feature is
 * for, so here it always says something.
 *
 * None of them names what the last call was about, because nothing knows. The call log
 * holds a date and whether a person took over; an opener that guessed at the subject would
 * be wrong often and confidently, in the first sentence, which is the worst place to be
 * either.
 */
const RETURNING: readonly string[] = [
  "Hi again.",
  "Hello again.",
  "Welcome back.",
  "Hi, good to hear from you again.",
];

/**
 * For somebody whose last call ended with a person taking over.
 *
 * A separate pool because the situation is different in a way the caller can feel: they
 * were handed on last time and are ringing back, so the opener acknowledges the thread
 * rather than the visit. Still says nothing about what it was.
 */
const RETURNING_AFTER_HANDOVER: readonly string[] = [
  "Hi again.",
  "Hello again — thanks for calling back.",
  "Welcome back.",
];

/** Every phrase that might be spoken, for the boot-time render. A blank is not audio. */
export const ALL_GREETING_LEADS: readonly string[] = [
  ...new Set(
    [
      ...Object.values(BY_PART_OF_DAY).flat(),
      ...OUT_OF_HOURS,
      ...RETURNING,
      ...RETURNING_AFTER_HANDOVER,
    ].filter((p) => p !== NOTHING),
  ),
];

/**
 * A small, stable hash of the call id.
 *
 * FNV-1a, and it does not need to be better than that: the only property required is that
 * two consecutive calls from one phone land on different indices more often than not.
 * `Math.random` would do that too, and would make this untestable — which is the actual
 * reason it is a hash.
 */
const hash = (value: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};

export interface GreetingContext {
  readonly partOfDay: PartOfDay;
  /** Null when the organisation configured no hours, which is treated as open. */
  readonly openNow: boolean | null;
  /** The carrier's id for this call. Varies between calls, holds still within one. */
  readonly callId: string;
  /**
   * What this number has done before, or null when it is not known.
   *
   * Null covers a withheld number, no database, and a read that did not arrive before the
   * greeting — and all three mean the same thing here: greet them as a stranger, which is
   * what every call did before this existed.
   */
  readonly history: {
    readonly lastContactDaysAgo: number | null;
    readonly lastCallHandedOver: boolean;
  } | null;
}

/** Beyond this they are not a returning caller, they are somebody who rang once. */
const RETURNING_WITHIN_DAYS = 14;

/**
 * The lead-in for this call, or null for none.
 *
 * Null is a real answer and the most frequent one — see `NOTHING`. Deterministic given the
 * call id, so one call always opens the same way however often the question is asked, and
 * two calls never have to agree.
 */
const poolFor = (context: GreetingContext): readonly string[] => {
  /* Ahead of the clock and ahead of the hours. "Good afternoon" to somebody who rang
     yesterday about a problem you have not fixed is a worse opener than no time of day at
     all — what they need to hear first is that they are not starting again. */
  const since = context.history?.lastContactDaysAgo ?? null;
  if (since !== null && since <= RETURNING_WITHIN_DAYS) {
    return context.history?.lastCallHandedOver === true ? RETURNING_AFTER_HANDOVER : RETURNING;
  }
  return context.openNow === false ? OUT_OF_HOURS : BY_PART_OF_DAY[context.partOfDay];
};

export const chooseGreetingLead = (context: GreetingContext): string | null => {
  const pool = poolFor(context);
  const picked = pool[hash(context.callId) % pool.length];
  return picked === undefined || picked === NOTHING ? null : picked;
};
