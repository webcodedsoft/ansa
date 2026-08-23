/**
 * The wall clock a Nigerian caller is reading.
 *
 * One definition, because there were about to be two. `outbound/consent.ts` has computed
 * the WAT hour since the consent gate landed, and the business-hours tool needs the same
 * arithmetic with a weekday attached. Two derivations of "what time is it there" is how
 * one of them ends up an hour out on a call nobody re-checks.
 *
 * There is no timezone database here and there should not be one. Nigeria is UTC+1 all
 * year with no daylight saving, so the conversion is addition — and 21:30 WAT is 20:30
 * UTC, which is the direction the sign has to go.
 */

/** Nigeria is UTC+1 year-round, with no daylight saving. */
const WAT_OFFSET_MINUTES = 60;

export interface WatMoment {
  /** 0-23. */
  readonly hour: number;
  /** 0-59. */
  readonly minute: number;
  /**
   * ISO-8601 weekday: 1 is Monday and 7 is Sunday.
   *
   * Not JavaScript's 0-is-Sunday, deliberately. Opening hours are written down as
   * "Monday to Friday", and a representation where the working week wraps around zero
   * turns every comparison into an off-by-one waiting to happen.
   */
  readonly weekday: number;
  /** Day of the month in WAT, 1-31. */
  readonly day: number;
  /** Month in WAT, 1-12. Not JavaScript's 0-11 — this is read by people. */
  readonly month: number;
  readonly year: number;
}

export const watMoment = (now: Date): WatMoment => {
  const shifted = new Date(now.getTime() + WAT_OFFSET_MINUTES * 60_000);
  const sunday0 = shifted.getUTCDay();
  return {
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: sunday0 === 0 ? 7 : sunday0,
    day: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    year: shifted.getUTCFullYear(),
  };
};

/** The hour a Nigerian caller's clock is showing. */
export const hourInWat = (now: Date): number => watMoment(now).hour;

/**
 * When an organisation's own line is staffed, in WAT.
 *
 * Here rather than in `@ansa/tools` because three packages need the shape and only one of
 * them may know what a tool is: the row is read in `@ansa/db`, carried through the organization
 * registry, and reasoned about in the business-hours tool.
 *
 * Not to be confused with `organizations.calling_earliest_hour`, which bounds when *we* may dial
 * someone. That is a constraint about other people's evenings and is clamped; this is a
 * claim an organisation makes about itself. See migration 0012.
 */
export interface BusinessHours {
  /** WAT hour the line opens, inclusive. 0-23. */
  readonly opensAtHour: number;
  /** WAT hour the line closes, exclusive, so a line that shuts at five holds 17. 1-24. */
  readonly closesAtHour: number;
  /** ISO weekdays the organisation is open: 1 is Monday, 7 is Sunday. */
  readonly openDays: readonly number[];
}
