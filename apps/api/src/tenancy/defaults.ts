/**
 * The base vocabulary every tenant inherits (R4.1.3).
 *
 * Every term here has been misheard on a live call — "policy" alone has come back as
 * apology, penalty, polling, course and puppy.
 *
 * Tenant terms are merged ON TOP of this, never in place of it. A tenant configuring
 * their own product names must not thereby lose "policy", and making the field a
 * replacement would let them do exactly that without noticing until a call goes wrong.
 *
 * What belongs in a keyterm list, learned the expensive way: boosting is a bias, not a
 * hint. A listed token wins ties against everything unlisted. A tenant's list once
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
export const BASE_KEYTERMS: readonly string[] = [
  "Ansa",
  "policy",
  "policy number",
  "premium",
  "naira",
  "claim",
  "renewal",
  "cover",
  "excess",
];

/**
 * Deepgram accepts a bounded keyterm list. The cap is enforced here rather than
 * discovered at the socket, and truncation is logged — a silently dropped keyterm looks
 * exactly like a transcriber that simply mishears the word.
 */
export const MAX_KEYTERMS = 100;
