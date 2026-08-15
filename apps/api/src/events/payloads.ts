import type { CallDirection } from "@ansa/telephony";
import { redactPayload, type RedactionPolicy } from "@ansa/tools";

import type { CallFacts, Fact } from "../conversation/call-facts";
import type { HandoffSummary } from "../handoff/summary";

/**
 * What an organisation is sent when one of its calls reaches a lifecycle point.
 *
 * Two payloads, because two lifecycle points are proven. Neither is invented here: the
 * call-ended one is the same material the recorder writes to `calls`, `transcripts` and
 * `call_events`, and the transferred one is the summary `handoff/summary.ts` already builds
 * for the person who picks up the phone. A third source of truth about what happened on a
 * call would drift from the other two within a week.
 *
 * Everything in this file is pure. The payload is built at the moment the event happens,
 * from state that is in memory then and gone a second later, and it is serialised once —
 * see `packages/db/src/event-deliveries.ts` for why fixing the bytes at that moment is what
 * makes at-least-once safe rather than merely repeated.
 */

/** The call, as an outside system needs to identify it. */
export interface CallIdentity {
  /** The carrier's id. What the organization's own phone bill and call logs show. */
  readonly callId: string;
  readonly direction: CallDirection;
  readonly dialled: string | null;
  readonly caller: string | null;
  readonly startedAt: string;
  readonly configVersion: number;
}

export interface TranscriptLine {
  readonly at: number;
  readonly speaker: "caller" | "agent";
  readonly text: string;
  /** The transcriber's own confidence, on caller lines. Null for the agent's own words. */
  readonly confidence: number | null;
}

export interface ReportedAction {
  readonly name: string;
  readonly outcome: string;
}

/**
 * A value the call established, with how well it was established.
 *
 * `confirmed` travels with the value and is not optional. An organisation writing a policy
 * number into their system from an event has to be able to tell the difference between one
 * the caller heard back and agreed to and one the transcriber offered once — the same
 * distinction R4.3.1 exists for, carried across the wire rather than dropped at it.
 */
export interface ReportedIdentifier {
  readonly value: string;
  readonly confirmed: boolean;
  readonly status: string;
}

export interface CallEndedPayload {
  readonly event: "call.ended";
  readonly occurredAt: string;
  readonly call: CallIdentity & {
    readonly endedAt: string;
    readonly endReason: string;
    readonly durationSeconds: number;
  };
  readonly identifiers: Readonly<Record<string, ReportedIdentifier>>;
  readonly transcript: readonly TranscriptLine[];
  readonly actions: readonly ReportedAction[];
  readonly transferredToHuman: boolean;
}

export interface CallTransferredPayload {
  readonly event: "call.transferred";
  readonly occurredAt: string;
  readonly call: CallIdentity;
  readonly reason: string | null;
  readonly summary: {
    readonly callerName: string | null;
    readonly wanted: string | null;
    readonly confirmed: readonly { subject: string; value: string }[];
    /** Heard and never agreed. Flagged, because the receiving system must not trust it. */
    readonly unconfirmed: readonly { subject: string; value: string }[];
    readonly actions: readonly ReportedAction[];
    readonly stillOpen: string | null;
    readonly callerTurns: number;
  };
}

const reported = (fact: Fact): ReportedIdentifier | null =>
  fact.value === null
    ? null
    : { value: fact.value, confirmed: fact.status === "CONFIRMED", status: fact.status };

/**
 * The identifiers a call established, keyed by field.
 *
 * Only the three the capture layer treats as identifying somebody. Intent and reason for
 * call are interpretive and belong in the transcript, not in a field an outside system
 * would key a customer record on.
 */
const reportedIdentifiers = (
  facts: CallFacts | null,
): Readonly<Record<string, ReportedIdentifier>> => {
  if (facts === null) return {};
  const out: Record<string, ReportedIdentifier> = {};
  for (const [field, fact] of [
    ["callerName", facts.callerName],
    ["policyNumber", facts.policyNumber],
    ["customerId", facts.customerId],
    // The operator's own fields. An organisation that configured the agent to collect a
    // claim number and subscribed to this event was getting an empty object.
    ...facts.captured,
  ] as const) {
    const value = reported(fact);
    if (value !== null) out[field] = value;
  }
  return out;
};

/**
 * Every form of an identifier this call has seen, for the redactor to match on.
 *
 * The `heard` list matters as much as the settled value and is the reason this is not just
 * `facts.policyNumber.value`. A caller says a reference three times and the transcriber
 * writes it down three ways; the settled value is one of them and the other two are still
 * sitting in the transcript. A organization who switched `captured-identifier` on and got two out
 * of three masked would reasonably call that broken.
 */
export const capturedIdentifierValues = (facts: CallFacts | null): readonly string[] => {
  if (facts === null) return [];
  const values = new Set<string>();
  /* Configured fields included, and this one is not a feature gap but a privacy defect.
     The redactor matches on this list. A NIN, a BVN or a one-time code collected through a
     configured field was never in it, so an organisation that switched `captured-identifier`
     masking on got the two built-ins masked and their national identity numbers left in
     the transcript in full — the exact "two out of three masked" failure the comment above
     calls broken. */
  for (const fact of [facts.callerName, facts.policyNumber, facts.customerId, ...facts.captured.values()]) {
    if (fact.value !== null) values.add(fact.value);
    for (const heard of fact.heard) values.add(heard);
  }
  // Longest first, so a value that contains a shorter one is masked whole rather than
  // being left with the tail of itself hanging out of a mask.
  return [...values].sort((a, b) => b.length - a.length);
};

export interface CallEndedInput {
  readonly call: CallIdentity;
  readonly endedAt: number;
  readonly endReason: string;
  readonly durationSeconds: number;
  readonly transcript: readonly TranscriptLine[];
  readonly actions: readonly ReportedAction[];
  readonly transferredToHuman: boolean;
  readonly facts: CallFacts | null;
}

export const callEndedPayload = (input: CallEndedInput): CallEndedPayload => ({
  event: "call.ended",
  occurredAt: new Date(input.endedAt).toISOString(),
  call: {
    ...input.call,
    endedAt: new Date(input.endedAt).toISOString(),
    endReason: input.endReason,
    durationSeconds: input.durationSeconds,
  },
  identifiers: reportedIdentifiers(input.facts),
  transcript: input.transcript,
  actions: input.actions,
  transferredToHuman: input.transferredToHuman,
});

export const callTransferredPayload = (input: {
  readonly call: CallIdentity;
  readonly at: number;
  readonly summary: HandoffSummary;
}): CallTransferredPayload => ({
  event: "call.transferred",
  occurredAt: new Date(input.at).toISOString(),
  call: input.call,
  reason: input.summary.escalation,
  summary: {
    callerName: input.summary.callerName,
    wanted: input.summary.reason,
    confirmed: input.summary.confirmed.map((v) => ({ subject: v.subject, value: v.value })),
    unconfirmed: input.summary.unconfirmed.map((v) => ({ subject: v.subject, value: v.value })),
    actions: input.summary.actions.map((a) => ({ name: a.name, outcome: a.outcome })),
    stillOpen: input.summary.unresolved,
    callerTurns: input.summary.callerTurns,
  },
});

/**
 * The payload as bytes, under this receiver's rules.
 *
 * The two things `redactPayload` does are not the same thing and it is worth saying which
 * is which at the one call site that matters. Credential-shaped keys go unconditionally,
 * because secret material is not the organisation's data to receive. Free text is touched
 * only if the organization asked for it: the default is `NO_REDACTION` and the default is that
 * an organisation gets a complete record of a conversation its own agent had.
 */
export const serialisePayload = (
  payload: CallEndedPayload | CallTransferredPayload,
  policy: RedactionPolicy,
  capturedIdentifiers: readonly string[],
): string => JSON.stringify(redactPayload(payload, policy, { capturedIdentifiers }));
