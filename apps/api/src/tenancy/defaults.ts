/**
 * The base vocabulary every organization inherits (R4.1.3).
 *
 * Every term here has been misheard on a live call, and — since Slice 7 — every term here
 * is also one that every organization on the platform needs. Those are two different bars and
 * the second is the one that was missing; see the note below the list.
 *
 * Organization terms are merged ON TOP of this, never in place of it. A organization configuring
 * their own product names must not thereby lose the platform's own, and making the field a
 * replacement would let them do exactly that without noticing until a call goes wrong.
 *
 * What belongs in a keyterm list, learned the expensive way: boosting is a bias, not a
 * hint. A listed token wins ties against everything unlisted. A organization's list once
 * carried Nigerian place and person names, and a caller saying their own name was
 * transcribed "Hi. My name is Ikeja."
 *
 * "Never personal names" was the rule that produced, and it is NOT SUFFICIENT. Measured
 * 2026-08-08 on identical synthetic audio, three runs each way, perfectly deterministic:
 * this exact list — with no personal name in it — turned "Sikiru" into "Akiro" on
 * Deepgram, and removing it gave "Sikiru" every time. Boosting domain vocabulary alone
 * damaged an adjacent proper noun.
 *
 * So the honest position is that a keyterm list has a cost to names near it, and that
 * cost has only been weighed on clean audio against one name. Deepgram is not in the live
 * path today (LISTEN_PROVIDER=openai, which cannot boost at all), so this is a landmine
 * for whoever switches rather than a fire now. Before switching, measure whether boosting
 * helps the words it targets by more than it hurts the ones it does not — nobody has.
 *
 * Until then: boost vocabulary that is closed and repeated — products, coverage types,
 * the company name — and keep the list as short as it can usefully be.
 */
/**
 * **The insurance words are gone, and that is the point of Slice 7.**
 *
 * This list used to read "policy", "policy number", "premium", "claim", "renewal",
 * "cover", "excess". Every one of them had been misheard on a live call, so each earned
 * its place — for the one organization selling insurance. The base is inherited by every organization,
 * and a second organization in an unrelated trade was having the first organization's vocabulary
 * boosted on their calls: a bias toward seven words their callers never say, on a list
 * this file already documents as damaging to proper nouns near it. Nobody's row was read
 * across a boundary. The leak was a default.
 *
 * They moved to that organization's own keyterms, where they always belonged, and where the merge
 * puts them back on top of this list for their calls only.
 *
 * What is left has to be true of every organisation on the platform, which is a much
 * harder test to pass than "it was misheard once":
 *
 *   Ansa   the agent says its own name in the greeting on every call, whoever it answers
 *          for, and it comes back as Answer, Anza and Ansar.
 *   naira  the currency of every caller this platform serves. The locale layer already
 *          treats it as universal here; a organization who never discusses money pays nothing
 *          for one extra term.
 *
 * A domain word does not go here. It goes in the organization's list.
 */
/**
 * Common Nigerian given names, boosted on every call.
 *
 * `capture.ts` says a caller's name "is unknown by definition, so there is nothing to
 * boost". True of the individual and false of the set: Yoruba, Igbo and Hausa given names
 * are a knowable vocabulary and an arbitrary caller's name is usually in it.
 *
 * Measured on `recordings/control-sikiru.ulaw`, same waveform every run:
 *
 *   no keyterms                 -> "Sikiru"   (clean audio only)
 *   7 domain terms, no names    -> "Akiro"
 *   50 names                    -> "Sikiru"
 *   50 names + the 7            -> "Sikiru"
 *
 * And on a real call, where the clean-audio result does not hold: without names Deepgram
 * dropped the name altogether — "My name is." — and with them returned "Sikiru".
 *
 * Kept well under the cap. Deepgram takes at most 100 terms and silently ignores the whole
 * list at 101, so this is a standing charge against every organisation's budget and is
 * deliberately shorter than it could be.
 */
const NIGERIAN_GIVEN_NAMES: readonly string[] = [
  "Sikiru", "Adebayo", "Adeyemi", "Babatunde", "Olumide", "Oluwaseun", "Abiodun", "Segun",
  "Tunde", "Femi", "Kunle", "Wale", "Seyi", "Kehinde", "Taiwo", "Damilola", "Temitope",
  "Folake", "Yewande", "Bolanle", "Funmilayo", "Bisi",
  "Chinedu", "Chukwuemeka", "Nnamdi", "Uchenna", "Ifeanyi", "Emeka", "Obinna", "Ekene",
  "Ngozi", "Chidinma", "Ifeoma", "Amaka", "Adaeze", "Chiamaka",
  "Ibrahim", "Aminu", "Usman", "Musa", "Yusuf", "Sadiq", "Bashir",
  "Fatima", "Zainab", "Aisha", "Halima", "Hauwa",
];

/**
 * What every call boosts before the organisation's own vocabulary is added.
 *
 * `mergedKeyterms` puts these first on purpose: when the list has to be cut it is the
 * terms that fail on *every* call that must survive, and a caller's name is exactly that.
 */
/**
 * The places and words a Nigerian caller says on any call, whatever the business.
 *
 * The same argument as the names, one level out: an individual address is unknown, but the
 * set of places callers name is a knowable vocabulary, and a transcriber that has never
 * been told "Lekki" returns "lucky". Kept to the places that recur across organisations —
 * the biggest cities and the Lagos areas a caller gives as a landmark — and the handful of
 * Pidgin words English models hear as something else. An organisation's own places go in
 * its own keyterms, where it can spend its share of the cap on them.
 *
 * Kano is not here, on purpose: a boost on four letters that sound like "cannot" would
 * bias a word said on every call towards a city named on few, and the evidence above is
 * that keyterm bias does exactly that. An organisation in Kano adds it to its own list.
 *
 * `Oga`, `Madam` and `Aunty` are here because they are how a caller addresses the agent,
 * and a mangled honorific in the transcript costs the model the register it is meant to
 * answer in. `Sir` and `Ma` are English and need no help.
 */
const NIGERIAN_PLACES_AND_WORDS: readonly string[] = [
  "Lagos", "Abuja", "Ikeja", "Lekki", "Ikoyi", "Ajah", "Yaba", "Surulere", "Ibadan",
  "Port Harcourt", "Enugu",
  "Oga", "Madam", "Aunty",
  "wahala", "abeg", "oya",
];

export const BASE_KEYTERMS: readonly string[] = [
  "Ansa",
  "naira",
  ...NIGERIAN_GIVEN_NAMES,
  ...NIGERIAN_PLACES_AND_WORDS,
];


/**
 * Deepgram accepts a bounded keyterm list. The cap is enforced here rather than
 * discovered at the socket, and truncation is logged — a silently dropped keyterm looks
 * exactly like a transcriber that simply mishears the word.
 */
export const MAX_KEYTERMS = 100;

/**
 * What is left of the cap for an organisation's own vocabulary.
 *
 * Asserted by a test, because the base list is a standing charge against every
 * organisation's budget and the only thing that stops it growing is somebody noticing.
 */
export const KEYTERMS_LEFT_FOR_ORGANISATIONS = MAX_KEYTERMS - BASE_KEYTERMS.length;
