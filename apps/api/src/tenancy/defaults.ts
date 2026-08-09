/**
 * The base vocabulary every tenant inherits (R4.1.3).
 *
 * Every term here has been misheard on a live call, and — since Slice 7 — every term here
 * is also one that every tenant on the platform needs. Those are two different bars and
 * the second is the one that was missing; see the note below the list.
 *
 * Tenant terms are merged ON TOP of this, never in place of it. A tenant configuring
 * their own product names must not thereby lose the platform's own, and making the field a
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
/**
 * **The insurance words are gone, and that is the point of Slice 7.**
 *
 * This list used to read "policy", "policy number", "premium", "claim", "renewal",
 * "cover", "excess". Every one of them had been misheard on a live call, so each earned
 * its place — for the one tenant selling insurance. The base is inherited by every tenant,
 * and a second tenant in an unrelated trade was having the first tenant's vocabulary
 * boosted on their calls: a bias toward seven words their callers never say, on a list
 * this file already documents as damaging to proper nouns near it. Nobody's row was read
 * across a boundary. The leak was a default.
 *
 * They moved to that tenant's own keyterms, where they always belonged, and where the merge
 * puts them back on top of this list for their calls only.
 *
 * What is left has to be true of every organisation on the platform, which is a much
 * harder test to pass than "it was misheard once":
 *
 *   Ansa   the agent says its own name in the greeting on every call, whoever it answers
 *          for, and it comes back as Answer, Anza and Ansar.
 *   naira  the currency of every caller this platform serves. The locale layer already
 *          treats it as universal here; a tenant who never discusses money pays nothing
 *          for one extra term.
 *
 * A domain word does not go here. It goes in the tenant's list.
 */
export const BASE_KEYTERMS: readonly string[] = ["Ansa", "naira"];

/**
 * Deepgram accepts a bounded keyterm list. The cap is enforced here rather than
 * discovered at the socket, and truncation is logged — a silently dropped keyterm looks
 * exactly like a transcriber that simply mishears the word.
 */
export const MAX_KEYTERMS = 100;
