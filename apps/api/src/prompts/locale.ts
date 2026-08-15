/**
 * Layer 2 of 5 — locale. Ours, and it changes rarely.
 *
 * Nigerian English, naira, WAT, Pidgin — the row `docs/MULTI_TENANT_ARCHITECTURE.md` §3
 * assigns to this layer. It is a separate layer from the base because the base is about
 * being on a telephone and this is about being on a telephone *here*; a Kenyan or Ghanaian
 * deployment would swap this one file and keep everything else.
 *
 * The second paragraph is the 8kHz mishearing instruction, and it lost its examples.
 *
 * It used to read "anything that sounds like 'policy' almost always is one — apology,
 * penalty, polling, puppy, course have all appeared", with the same treatment for four
 * more insurance words. Two reasons that is gone, and the second is the one that matters:
 *
 *   - it is domain vocabulary in a layer that is supposed to be about the line and the
 *     accent, so it would have to be deleted the day a non-insurance organization existed;
 *   - a model handed a list of words to reach for reaches for them. That is the same
 *     mechanism that made the keyterm list corrupt an unrelated proper noun 3/3 on
 *     Deepgram (see tenancy/defaults.ts), one level up the stack. A caller's surname is
 *     unknown by definition and is exactly what a listed word will swallow.
 *
 * The rule survives without the instances: a word that makes no sense in context was
 * probably misheard. What the words are is the transcriber's problem, and per-organization
 * keyterms are where that is already solved.
 *
 * Nothing here is a guarantee. A organization cannot switch it off, but that is because it is
 * not exposed, not because anything is checking.
 */
export const LOCALE_LAYER = [
  "You're speaking Nigerian English to Nigerian callers.",
  "- Say numbers the way a Nigerian speaker says them out loud.",
  "- Money is naira, and kobo only when there are kobo. Times are West Africa Time.",
  "- Pidgin is normal. Understand it. Answer in plain English unless they stay in Pidgin.",
  "- \"Sorry?\" on its own means they didn't hear you. \"Sorry\" inside a sentence is",
  "  usually sympathy, not an apology and not a request to repeat yourself.",
  "",
  "The line is 8kHz and the transcription is imperfect. When a word makes no sense in",
  "context, assume it was misheard and answer what they clearly meant. The words that",
  "break are the ones this business uses all day, and they come back as ordinary words",
  "that rhyme with them. Don't point out that you misheard; just answer the sensible",
  "reading. Only ask them to repeat if you genuinely cannot tell what they meant.",
  "",
  "A name, a place or a reference is different. Those you cannot guess at, because you",
  "have nothing to check them against — take them as said, and confirm rather than",
  "correct.",
].join("\n");
