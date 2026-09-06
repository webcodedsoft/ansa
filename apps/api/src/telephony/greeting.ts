import { mergeFacts } from "@ansa/shared";

/**
 * Slice 1 spoke exactly this and hung up. Slice 3 opens the conversation with it and
 * then listens, so it ends with a handover: a caller who is only greeted does not know
 * it is their turn, and the question is also a complete clause for semantic end-of-turn
 * detection to commit against.
 *
 * It is the real brand name rather than a placeholder so the phone-line test in
 * PRD §1.0 happens on every call.
 */
export const GREETING_TEXT = "Thank you for calling Ansa. How can I help you?";

/** Why we rang, as the campaign wrote it. Facts are this person's own, merged into both. */
export interface OutboundReason {
  /** The tail of "I'm calling…": "to confirm your viewing on {date}". */
  readonly purpose: string;
  /** The exact first line, when the operator wrote one. Spoken as written. */
  readonly opening: string | null;
  readonly facts: Readonly<Record<string, string>> | null;
}

/**
 * What an outbound call opens with, which cannot be the greeting.
 *
 * A organisation writes one greeting and writes it for their own phone ringing. Oakhaven's
 * asked "Are you calling about a property to rent, to buy, or something else?" on a call the
 * agent had placed; the caller answered "Yeah, look at that."
 *
 * Says who rang, that we rang, why, and offers a way out — consent to be called, settled in
 * `mayCall`, is not consent to talk now. Ends on a question so end-of-turn has a clause.
 *
 * The reason is spoken here, in the first line, and not left to the model. `prompts/outbound.ts`
 * tells the model to say who, which company and why before anything else, but this line is
 * synthesised before the model has a turn — so a version without the reason had the agent
 * asking "is now a good time?" of somebody who did not yet know what for, and the model
 * composing the reason a turn later in whatever words it chose. A campaign's `purpose` reads
 * as the tail of "I'm calling…" (the template tests hold it to that), so it drops straight in.
 * An operator who wrote the exact first line gets it verbatim: that is what the field promises.
 *
 * Null reason is the generic line, for the two callers that have none: the warm at ingress,
 * which does not yet know which campaign, and an outbound call no campaign placed (a test
 * call), where the person on the other end is the operator.
 */
export const outboundOpener = (agentName: string, reason: OutboundReason | null = null): string => {
  const who = agentName.trim();
  if (reason !== null) {
    const opening = reason.opening === null ? "" : mergeFacts(reason.opening, reason.facts).trim();
    if (opening !== "") return opening;
    const why = mergeFacts(reason.purpose, reason.facts).trim().replace(/[.!?]+$/, "");
    if (why !== "") {
      return who === ""
        ? `Good day. I'm calling ${why}. Is now a good time?`
        : `Good day, this is ${who} calling ${why}. Is now a good time?`;
    }
  }
  // `agents.name` is not null, so this is unreachable through the product — but the argument
  // is a string, and the failure would be heard rather than caught.
  if (who === "") return "Good day. Is now a good time to talk?";
  return `Good day, this is ${who} calling. Is now a good time?`;
};

/**
 * The opening line, with the recording disclosure when this organisation records.
 *
 * Said rather than configured. An organisation that turns recording on does not get to choose
 * whether the caller is told, because the disclosure is what makes holding somebody's voice
 * defensible under NDPR — and a settable one would be the first setting turned off.
 *
 * It goes after the greeting rather than before it. "This call is recorded. Thank you for
 * calling Ansa" opens on a warning; the greeting first is how a person would say it, and the
 * caller still hears it before saying anything worth recording.
 *
 * Short on purpose: this is spoken on every call, and every word is a word before the caller
 * can begin. Nothing is added when the organisation does not record, so the common case is
 * exactly the line it was before.
 */
export const withRecordingNotice = (opening: string, recording: boolean): string => {
  if (!recording) return opening;
  const said = opening.trimEnd();
  const stop = /[.!?]$/.test(said) ? "" : ".";
  return `${said}${stop} This call is recorded.`;
};

/**
 * Whether a campaign call has nothing to open with, in which case it is hung up.
 *
 * Null or empty, not just null: the brief is null when the read failed or when the ids on
 * the socket are not this organisation's, and the purpose is empty only if something got
 * past the start gate. Either way the agent would be ringing a member of the public with no
 * idea why, and the model would compose a reason — a cold call with a made-up pretext, from
 * a number the organisation owns. Returns the reason for the log line, or null to carry on.
 *
 * Only a *campaign* call. An outbound call with no campaign id is a test call, and the
 * person answering is the operator; inbound calls have a caller with their own reason.
 */
export const campaignCallCannotOpen = (call: {
  readonly direction: "inbound" | "outbound";
  readonly campaignId: string | null;
  readonly brief: { readonly purpose: string } | null;
}): string | null => {
  if (call.direction !== "outbound" || call.campaignId === null) return null;
  if (call.brief === null) return "brief unreadable or not this organisation's";
  if (call.brief.purpose.trim() === "") return "purpose is empty";
  return null;
};

/**
 * Re-exported so the speech path keeps one import, but the implementation now lives in
 * packages/normalizer. Nothing reaches TTS unnormalized — greetings included, since a
 * static string today becomes a per-organization template with a number in it tomorrow.
 */
export { forSpeech } from "@ansa/normalizer";
