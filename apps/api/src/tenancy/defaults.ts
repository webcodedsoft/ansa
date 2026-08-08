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
 * transcribed "Hi. My name is Ikeja." Boost vocabulary that is closed and repeated -
 * products, coverage types, the company name. Never vocabulary that competes with what
 * callers say freely, and never personal names: the caller's name is unknown by
 * definition and is precisely what a boosted name will swallow.
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
