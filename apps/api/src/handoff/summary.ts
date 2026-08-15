import { forSpeech, sayReference } from "@ansa/normalizer";
import type { OrganizationId } from "@ansa/shared";

/**
 * The handoff summary, reduced from the call's own event log.
 *
 * There is deliberately no second store behind this. Everything below is derived from the
 * events the orchestrator already writes to `call_events` — `caller said`,
 * `entity_candidate`, `value confirmed`, `agent said` — read through the same shape the
 * table holds. A parallel record of "what we know about this caller" would drift from the
 * transcript the moment one of the two was updated and the other was not, and the log is
 * the one that a reviewer can check against the audio.
 *
 * What the summary is FOR sets what belongs in it. A person has just picked up a phone
 * and has perhaps eight seconds before the caller starts talking. They need: who this is,
 * what they want, what has already been established so they do not ask again, what the
 * agent already did, and what is still open. Nothing else earns the seconds.
 */

/** One row of `call_events`, as the reducer needs it. Nothing carrier- or vendor-shaped. */
export interface LoggedEvent {
  readonly kind: string;
  readonly detail: unknown;
  readonly offsetMs: number | null;
}

/**
 * A value the caller gave and then agreed to when it was read back.
 *
 * `confirmed` is the whole distinction this type exists to carry. A caller who spent four
 * minutes spelling their name must not be asked again — and a candidate the agent heard
 * once and never confirmed must not be repeated to them as fact, because it is most
 * likely wrong. Both failures are worse than saying nothing, and they pull in opposite
 * directions, so the summary reports them separately.
 */
export interface CapturedValue {
  readonly subject: string;
  readonly value: string;
  readonly confirmed: boolean;
  readonly offsetMs: number | null;
}

/** Something the agent actually did, as opposed to something it said it would do. */
export interface PerformedAction {
  readonly name: string;
  readonly outcome: string;
  readonly detail: string | null;
}

export interface HandoffSummary {
  readonly organizationId: OrganizationId | null;
  readonly carrierCallId: string;
  /** As the carrier reported it. Withheld numbers arrive as "anonymous", not as absent. */
  readonly callerNumber: string | null;
  /** Confirmed by readback, or null. Never a candidate the caller has not agreed to. */
  readonly callerName: string | null;
  /** Why they rang, in their own words: their first substantive turn. */
  readonly reason: string | null;
  readonly confirmed: readonly CapturedValue[];
  /**
   * Heard, put to the caller, never agreed. Present so the person can ask about it rather
   * than starting from nothing — "was your reference A B one two three?" — and flagged so
   * they never state it as fact.
   */
  readonly unconfirmed: readonly CapturedValue[];
  readonly actions: readonly PerformedAction[];
  /** The last thing the caller said. Usually the thing still outstanding. */
  readonly unresolved: string | null;
  /** Why the agent gave up. Null when a person was asked for without a failure. */
  readonly escalation: string | null;
  readonly callerTurns: number;
}

export interface SummaryInput {
  readonly organizationId: OrganizationId | null;
  readonly carrierCallId: string;
  readonly callerNumber: string | null;
  readonly events: readonly LoggedEvent[];
  /** Why the handoff was triggered, as the escalation watch named it. */
  readonly escalation?: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const wordCount = (text: string): number => text.split(/\s+/).filter((w) => w.length > 0).length;

/**
 * Openings that carry no request. "Hello", "good afternoon", "can you hear me" — every
 * call starts with one or two and none of them is why the caller rang.
 */
const PLEASANTRY =
  /^(hi|hello|hey|good (morning|afternoon|evening|day)|how (are|far)|you dey hear me|can you hear me|are you there|yes|okay|please)\b/i;

/**
 * The first turn that is actually a request rather than a greeting.
 *
 * Two passes rather than one heuristic. "Good afternoon, can you hear me" is six words
 * and still not why anyone rang, and no word count separates it from a short real
 * request — but it opens with a greeting and a real request almost never does. When every
 * turn is a pleasantry the first one is returned anyway: a thin reason beats none, and the
 * person answering can read the rest of the summary.
 */
const reasonFrom = (callerTurns: readonly string[]): string | null => {
  const substantial = callerTurns.filter((t) => wordCount(t) >= 3);
  return substantial.find((t) => !PLEASANTRY.test(t)) ?? substantial[0] ?? callerTurns[0] ?? null;
};

/**
 * Which candidate the caller agreed to.
 *
 * The orchestrator records `value confirmed` with a character count and not the value —
 * deliberately, since a call event holding a policy number in plain text is a different
 * conversation about retention. So the value is recovered from the `entity_candidate` it
 * confirms: capture reads back exactly one value at a time, and the length check makes the
 * pairing verifiable rather than assumed.
 *
 * When nothing matches, the most recent candidate is taken and nothing is invented. Being
 * one readback stale is recoverable by a person; a value that was never said is not.
 */
const matchConfirmed = (
  candidates: readonly CapturedValue[],
  chars: number | null,
): CapturedValue | null => {
  if (candidates.length === 0) return null;
  if (chars !== null) {
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const candidate = candidates[i];
      if (candidate !== undefined && candidate.value.length === chars) return candidate;
    }
  }
  return candidates[candidates.length - 1] ?? null;
};

/** Every tool the dispatch path reports, whatever the adapter behind it. */
const TOOL_KINDS = new Set(["tool_result", "tool_invoked", "tool_failed", "tool dispatched"]);

export const summarise = (input: SummaryInput): HandoffSummary => {
  const callerTurns: string[] = [];
  const candidates: CapturedValue[] = [];
  const confirmed: CapturedValue[] = [];
  const actions: PerformedAction[] = [];
  let escalation = input.escalation ?? null;

  for (const event of input.events) {
    const detail = isRecord(event.detail) ? event.detail : {};

    if (event.kind === "caller said") {
      const text = readString(detail["text"]);
      if (text !== null) callerTurns.push(text);
      continue;
    }

    if (event.kind === "entity_candidate") {
      const value = readString(detail["value"]);
      if (value === null) continue;
      candidates.push({
        subject: readString(detail["subject"]) ?? "value",
        value,
        confirmed: false,
        offsetMs: event.offsetMs,
      });
      continue;
    }

    if (event.kind === "value confirmed") {
      const match = matchConfirmed(candidates, readNumber(detail["chars"]));
      // Also the keypad path, which confirms without a readback: capture records the
      // value straight rather than as a candidate, because keypad tones are unambiguous.
      const typed = readString(detail["value"]);
      if (typed !== null) {
        confirmed.push({
          subject: readString(detail["subject"]) ?? "number",
          value: typed,
          confirmed: true,
          offsetMs: event.offsetMs,
        });
      } else if (match !== null) {
        confirmed.push({ ...match, confirmed: true });
      }
      // Everything offered before this belonged to the entity just settled.
      candidates.length = 0;
      continue;
    }

    if (event.kind === "escalated to a human" && escalation === null) {
      escalation = readString(detail["reason"]) ?? "capture failed after spelling and keypad";
      continue;
    }

    if (TOOL_KINDS.has(event.kind)) {
      const name = readString(detail["name"]);
      if (name === null) continue;
      actions.push({
        name,
        outcome: readString(detail["outcome"]) ?? "unknown",
        detail: readString(detail["summary"]) ?? readString(detail["result"]),
      });
    }
  }

  const name = [...confirmed].reverse().find((v) => v.subject === "name") ?? null;

  return {
    organizationId: input.organizationId,
    carrierCallId: input.carrierCallId,
    callerNumber: input.callerNumber,
    callerName: name === null ? null : name.value,
    reason: reasonFrom(callerTurns),
    confirmed,
    // Anything still outstanding when the call was handed over: offered and never agreed.
    unconfirmed: [...candidates],
    actions,
    unresolved: callerTurns[callerTurns.length - 1] ?? null,
    escalation,
    callerTurns: callerTurns.length,
  };
};

/**
 * The summary as text, for the event log and the internal viewer.
 *
 * Written for a person reading it after the fact, so it keeps the detail the spoken
 * version has to drop.
 */
export const renderSummary = (summary: HandoffSummary): string => {
  const lines: string[] = [];
  lines.push(`Caller: ${summary.callerName ?? "name not established"} (${summary.callerNumber ?? "number withheld"})`);
  lines.push(`Wanted: ${summary.reason ?? "not established"}`);

  for (const value of summary.confirmed) {
    lines.push(`Confirmed ${value.subject}: ${value.value}`);
  }
  for (const value of summary.unconfirmed) {
    // Marked, never stated. The agent heard it once and the caller never agreed.
    lines.push(`UNCONFIRMED ${value.subject}: ${value.value} — do not treat as correct`);
  }
  for (const action of summary.actions) {
    lines.push(`Did: ${action.name} — ${action.outcome}${action.detail === null ? "" : ` (${action.detail})`}`);
  }

  lines.push(`Still open: ${summary.unresolved ?? "nothing stated"}`);
  lines.push(`Transferred because: ${summary.escalation ?? "the caller asked for a person"}`);
  return lines.join("\n");
};

/** A reference spoken digit by digit; a name spoken as written. */
const speakValue = (value: CapturedValue): string =>
  value.subject === "name" ? value.value : sayReference(value.value);

/**
 * The summary as the person answering hears it, before the legs are joined.
 *
 * Ruthlessly short, and the order is not cosmetic. Whoever picks up is standing with a
 * live caller on the other side of it: they get who, what, and what is already settled,
 * and the rest can be asked. Everything past about fifteen seconds is time the caller
 * spends listening to silence — which is why unconfirmed candidates are named as
 * unconfirmed but not enumerated, and why the tool detail is dropped.
 *
 * Normalized on the way out. The carrier's own TTS is still TTS: a raw policy number here
 * is read as a quantity, which is exactly the mistake the normalizer exists to prevent.
 */
export const speakSummary = (summary: HandoffSummary): string => {
  const parts: string[] = ["Transfer from the Ansa assistant."];

  parts.push(
    summary.callerName === null
      ? "The caller's name was not established."
      : `The caller is ${summary.callerName}.`,
  );

  if (summary.reason !== null) parts.push(`They called about: ${summary.reason}.`);

  const references = summary.confirmed.filter((v) => v.subject !== "name");
  if (references.length > 0) {
    // "Already confirmed" is the operative phrase: it tells the person not to ask again,
    // which is the entire reason the transfer carries anything at all.
    parts.push(
      `Already confirmed: ${references.map((v) => `${v.subject} ${speakValue(v)}`).join(", ")}.`,
    );
  }

  const failed = summary.actions.filter((a) => a.outcome !== "ok");
  if (summary.actions.length > 0) {
    parts.push(
      failed.length === 0
        ? `The assistant completed ${summary.actions.map((a) => a.name).join(" and ")}.`
        : `${failed.map((a) => a.name).join(" and ")} failed.`,
    );
  }

  if (summary.unconfirmed.length > 0) {
    parts.push("Some details were heard but never confirmed, so please check them.");
  }

  parts.push(`Reason for transfer: ${summary.escalation ?? "the caller asked for a person"}.`);
  parts.push("Connecting you now.");

  return forSpeech(parts.join(" "));
};
