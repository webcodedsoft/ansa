import type { CallRecord } from "@ansa/db";

/**
 * Whether the calls we placed are going well, which is a different question from whether
 * the calls we answered are.
 *
 * An inbound call is answered by definition, so every rate here would be meaningless
 * computed over both: a connect rate across mixed traffic mostly measures how much inbound
 * there was. Outbound only, and splitting them is the first thing this does.
 *
 * The brief names four figures and one of them is the alarm. A rising do-not-call rate is
 * not a quality problem to look at next week — it is a list or a script annoying people,
 * compounding, and every one of those requests is permanent. It is here so it can be seen
 * before it is seen in complaints.
 *
 * Pure arithmetic over the same `CallRecord[]` that `scoreCalls` and `priceUsage` read.
 */

/**
 * Statuses the carrier reports for a call that never reached anybody.
 *
 * Written by `closeCallByCarrierId` from the status callback, which exists precisely
 * because these happen with no media stream — before it, a call that rang out was
 * indistinguishable from one that was never placed.
 */
const NEVER_CONNECTED: ReadonlySet<string> = new Set([
  "no-answer",
  "busy",
  "failed",
  "canceled",
  "cancelled",
]);

export interface OutboundMetrics {
  readonly calls: number;
  /** Reached somebody or something, rather than ringing out. Null when nothing was placed. */
  readonly connectRate: number | null;
  /**
   * Of the calls that connected, how many reached a person.
   *
   * From the carrier's own answering-machine verdict, recorded per call since migration
   * 0045. Null when nothing connected — and, worth knowing when reading it, computed only
   * over calls the carrier gave a verdict for, so it says nothing about calls where
   * detection was off.
   */
  readonly humanAnswerRate: number | null;
  /** Calls the carrier gave a verdict for: the denominator above, stated so it can be judged. */
  readonly answeredByKnown: number;
  /**
   * Calls on which somebody asked never to be called again.
   *
   * The alarm. Each one is a permanent, platform-wide suppression, so a rate that climbs is
   * a list or a script burning through numbers nobody can ever dial again.
   */
  readonly doNotCallRate: number | null;
  /**
   * How long a connected call lasted, at the median.
   *
   * The median rather than the mean the brief asks for, for the reason percentiles are used
   * everywhere else here: one four-minute call among fifty ten-second ones moves an average
   * and tells you nothing about the fifty. A collapsing median is what "they are hanging up
   * on us" looks like.
   */
  readonly medianSecondsToHangup: number | null;
}

const rate = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  const lower = sorted[middle - 1];
  return sorted.length % 2 === 1 || lower === undefined ? upper : Math.round((lower + upper) / 2);
};

const detailOf = (detail: unknown): Record<string, unknown> =>
  typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>) : {};

export const outboundMetrics = (records: readonly CallRecord[]): OutboundMetrics => {
  const placed = records.filter((call) => call.direction === "outbound");
  if (placed.length === 0) {
    return {
      calls: 0,
      connectRate: null,
      humanAnswerRate: null,
      answeredByKnown: 0,
      doNotCallRate: null,
      medianSecondsToHangup: null,
    };
  }

  let connected = 0;
  let answeredByKnown = 0;
  let humans = 0;
  let suppressions = 0;
  const durations: number[] = [];

  for (const call of placed) {
    /* A null end reason is a call still in progress, or one whose closing was lost. Counted
       as connected, because the alternative reports every live call as a failure to reach
       anybody. */
    const reached = call.endReason === null || !NEVER_CONNECTED.has(call.endReason);
    if (reached) {
      connected += 1;
      if (call.durationSeconds !== null) durations.push(call.durationSeconds);
    }

    /* Once per call, however many times they said it. Somebody repeating themselves is one
       person asking, and counting the repeats would make one angry caller look like a
       trend on the number that is supposed to reveal trends. */
    if (call.events.some((event) => event.kind === "do_not_call_recorded")) suppressions += 1;

    const verdict = call.events.find((event) => event.kind === "answered_by");
    if (verdict === undefined) continue;
    const answeredBy = detailOf(verdict.detail)["answeredBy"];
    if (typeof answeredBy !== "string") continue;
    answeredByKnown += 1;
    /* "unknown" counts as neither. The carrier could not tell, and folding that into either
       side puts its uncertainty into a number that will be read as fact. */
    if (answeredBy === "human") humans += 1;
  }

  return {
    calls: placed.length,
    connectRate: rate(connected, placed.length),
    humanAnswerRate: rate(humans, answeredByKnown),
    answeredByKnown,
    doNotCallRate: rate(suppressions, placed.length),
    medianSecondsToHangup: median(durations),
  };
};
