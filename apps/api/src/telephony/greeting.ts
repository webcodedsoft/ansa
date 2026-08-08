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
 * Re-exported so the speech path keeps one import, but the implementation now lives in
 * packages/normalizer. Nothing reaches TTS unnormalized — greetings included, since a
 * static string today becomes a per-tenant template with a number in it tomorrow.
 */
export { forSpeech } from "@ansa/normalizer";
