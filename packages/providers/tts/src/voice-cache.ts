import type { VoiceCatalogue, VoiceListing } from "./types";

/**
 * A listing that is read once and shown many times.
 *
 * The catalogue is opened by every operator who opens the Voice tab, and the answer is the
 * same for all of them: it describes an ElevenLabs account, not an organisation. Left
 * uncached that is three vendor requests per page load, on a page nobody visits to find
 * out what changed in the last minute.
 *
 * Three things this does that a plain `Map` would not:
 *
 * - **Only successes are remembered.** A vendor outage cached for five minutes is an
 *   outage that outlives itself, and the operator retrying is doing the right thing.
 * - **A partial listing is remembered briefly.** `libraryUnread` means the library did not
 *   answer. That is still worth caching — otherwise a persistently broken library means
 *   every page load hits the vendor — but not for as long, because the moment it recovers
 *   the cached answer is wrong in the direction of showing fewer voices than exist.
 * - **Concurrent callers share one request.** Two tabs opened together are one fetch. Without
 *   this the cache is empty exactly when the load arrives, which is when it matters.
 *
 * `knows` is passed straight through. It is a different question — one voice, asked during
 * a readiness check where staleness is the whole failure mode — and caching it would mean
 * reporting a voice as fine minutes after it was deleted.
 */

export interface CachedListingOptions {
  /** How long a complete listing is served from memory. */
  readonly ttlMs?: number;
  /** Injected in tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60_000;

/** Long enough to absorb a page load, short enough that a recovered library shows up. */
const PARTIAL_TTL_MS = 30_000;

interface Held {
  readonly listing: VoiceListing;
  readonly expiresAt: number;
}

export const withCachedListing = (
  inner: VoiceCatalogue,
  options: CachedListingOptions = {},
): VoiceCatalogue => {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  let held: Held | null = null;
  let inFlight: Promise<VoiceListing> | null = null;

  const fetchOnce = async (): Promise<VoiceListing> => {
    const listing = await inner.list();
    const lifetime = listing.libraryUnread ? Math.min(ttlMs, PARTIAL_TTL_MS) : ttlMs;
    held = { listing, expiresAt: now() + lifetime };
    return listing;
  };

  return {
    name: inner.name,
    knows: (voiceId: string) => inner.knows(voiceId),
    list: async (): Promise<VoiceListing> => {
      const current = held;
      if (current !== null && now() < current.expiresAt) return current.listing;
      // Joining an in-flight read rather than starting a second one, and cleared in a
      // `finally` so a rejection does not wedge every later caller onto a settled failure.
      inFlight ??= fetchOnce().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
};
