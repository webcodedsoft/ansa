import { api, refusedWith } from "@/lib/api/server";
import { DEFAULT_PAGE_SIZE } from "@/lib/paging";

import type { CorrectionInput, TestCallInput } from "./calls.schema";

/**
 * Everything this app does with calls.
 *
 * The two read functions are what the pages render and the two write functions are what the
 * actions send. Keeping them together is what stops the list page and the detail page from
 * disagreeing about what a call is.
 */

/** The filters `GET /calls` supports, straight through — the API is the authority. */
export interface CallFilters {
  /** 1-based, as the API counts them. Absent means the first page. */
  readonly page?: number;
  /** Rows per page. Absent means the app's default, not the API's. */
  readonly perPage?: number;
  /**
   * Calls one agent handled (migration 0018).
   *
   * Not interchangeable with `dialled`: a number can be moved between agents, so this
   * stays true after a reassignment where filtering by number does not.
   */
  readonly agentId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly endReason?: string;
  readonly caller?: string;
  readonly dialled?: string;
  readonly minDurationSeconds?: number;
  readonly reviewed?: boolean;
}

/** One page of calls, newest first. Page numbers, 1-based, as the API counts them. */
export const listCalls = async (filters: CallFilters = {}) => {
  const query: Record<string, string | number | boolean> = { perPage: DEFAULT_PAGE_SIZE };
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") query[key] = value as string | number | boolean;
  }
  return (await api()).calls.list({ query });
};

/**
 * One call, or null when this organisation has no such call.
 *
 * Null rather than a thrown 404, because "not ours" is an ordinary answer here and the page
 * has a sensible response to it. A call belonging to another organisation lands in the same
 * branch, which is correct: row-level security means this session genuinely cannot see the
 * row, so not-found is the truthful answer and not a euphemism for forbidden.
 */
export const findCall = async (callId: string) => {
  try {
    return await (await api()).calls.detail({ path: { callId } });
  } catch (error) {
    if (refusedWith(error, 404)) return null;
    throw error;
  }
};

/**
 * Ring a number and let this organisation's agent answer it.
 *
 * Answers 202, not 200: the call is queued with the carrier, not connected. So this returns
 * what was accepted and says nothing about how it went — that arrives on the call itself.
 */
export const placeTestCall = async (input: TestCallInput) =>
  (await api()).testCalls.place({ body: { to: input.to } });

/**
 * Record a review verdict on one transcript.
 *
 * Submitting the transcriber's own words back is a verdict, not a no-op: it marks the
 * transcript reviewed and correct, and `changed` reports which it was. That distinction is
 * the value of the review screen, so it is passed through rather than collapsed.
 */
export const recordCorrection = async (input: CorrectionInput) =>
  (await api()).calls.correct({
    path: { callId: input.callId, transcriptId: input.transcriptId },
    body: { correctedText: input.correctedText },
  });

/**
 * Calls still in progress, right now.
 *
 * There is no live endpoint — the API's shape is a paginated history, not a subscription.
 * This reads the first page of it and keeps whatever has not ended yet, which is exactly
 * right for one page and only approximately right if calls are landing fast enough to push
 * an in-progress one off the end of it. Nobody running this product is at that scale yet.
 */
export const listLiveCalls = async () => {
  const { items } = await listCalls();
  return items.filter((call) => call.endedAt === null);
};

/** Quality metrics over this organisation's recent calls. */
export const callMetrics = async () => (await api()).calls.metrics();

/** Quality by configuration version, so a rollout's effect is visible against the last one. */
export const callTrends = async () => (await api()).calls.trends();

/**
 * How the calls we placed are going, which is a different question from the ones we answered.
 *
 * Outbound only. An inbound call is answered by definition, so a connect rate computed across
 * both mostly measures how much inbound traffic there was.
 */
export const outboundMetrics = async () => (await api()).calls.outbound();

export type OutboundMetrics = Awaited<ReturnType<typeof outboundMetrics>>;

/** Calls worth reviewing first, worst rated highest. */
export const listReviewQueue = async () => (await api()).calls.reviewQueue({});

export type CallPage = Awaited<ReturnType<typeof listCalls>>;
export type CallSummary = CallPage["items"][number];
export type CallDetail = NonNullable<Awaited<ReturnType<typeof findCall>>>;
export type CallTranscript = CallDetail["transcripts"][number];
export type CallEvent = CallDetail["events"][number];
export type LiveCall = Awaited<ReturnType<typeof listLiveCalls>>[number];
export type CallMetrics = Awaited<ReturnType<typeof callMetrics>>;
export type CallTrends = Awaited<ReturnType<typeof callTrends>>;
export type TrendRow = CallTrends["versions"][number];
export type ReviewQueue = Awaited<ReturnType<typeof listReviewQueue>>;
export type FlaggedCall = ReviewQueue["calls"][number];
