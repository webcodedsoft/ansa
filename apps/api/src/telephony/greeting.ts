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
 * The brand is "Ansa" everywhere a human reads it. TTS is handed "An-Sah" instead,
 * because the telephone channel destroys the name otherwise.
 *
 * /s/ carries most of its energy above 4kHz. The telephony passband ends near 3.4kHz and
 * μ-law discards the rest, so between a nasal and a vowel the stripped fricative is heard
 * as its voiced neighbour and callers hear "Anza". Confirmed by A/B on a real call: the
 * same sentence at pcm_24000 is a correct "Ansa", at ulaw_8000 it is not — the model is
 * right and the channel is wrong. The respelling makes the model produce a longer, harder
 * fricative, so enough survives the band-pass to be heard correctly.
 *
 * This is a normalizer rule wearing a temporary disguise. When packages/normalizer lands
 * in Slice 4 it moves there and applies to every utterance — CLAUDE.md: nothing reaches
 * TTS unnormalized. The orchestrator already routes every utterance through it.
 */
export const forSpeech = (text: string): string => text.replace(/\bAnsa\b/g, "An-Sah");
