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

/**
 * What an outbound call opens with, which cannot be the greeting.
 *
 * A organisation writes one greeting and writes it for their own phone ringing. Oakhaven's
 * asked "Are you calling about a property to rent, to buy, or something else?" on a call the
 * agent had placed; the caller answered "Yeah, look at that."
 *
 * Says who rang, that we rang, and offers a way out — consent to be called, settled in
 * `mayCall`, is not consent to talk now. Ends on a question so end-of-turn has a clause.
 *
 * A configurable version needs a column and a positional argument on
 * `publish_agent_config_for_agent`. That is its own slice.
 */
export const outboundOpener = (agentName: string): string => {
  const who = agentName.trim();
  // `agents.name` is not null, so this is unreachable through the product — but the argument
  // is a string, and the failure would be heard rather than caught.
  if (who === "") return "Good day. Is now a good time to talk?";
  return `Good day, this is ${who} calling. Is now a good time?`;
};

/**
 * Re-exported so the speech path keeps one import, but the implementation now lives in
 * packages/normalizer. Nothing reaches TTS unnormalized — greetings included, since a
 * static string today becomes a per-organization template with a number in it tomorrow.
 */
export { forSpeech } from "@ansa/normalizer";
