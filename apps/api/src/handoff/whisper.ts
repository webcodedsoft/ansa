import { randomBytes } from "node:crypto";

/**
 * The summary spoken to the person answering, held for as long as it takes their phone
 * to ring.
 *
 * The carrier fetches it over the public internet, which is the whole design constraint:
 * the URL is the only credential, so it has to be unguessable, single use, and short
 * lived. A predictable one — the call id, say — would let anyone who can reach the tunnel
 * read out what a caller confirmed on a call they have nothing to do with, and the
 * summary is the most concentrated personal data the product produces.
 *
 * In memory on purpose. It lives for one ring cycle and a process restart mid-transfer
 * should lose it rather than leave it lying in a table with a retention policy nobody
 * wrote.
 */
export interface WhisperRegistry {
  /** Returns the token to put in the URL. */
  readonly offer: (line: string) => string;
  /** Null when unknown, expired, or already taken. */
  readonly take: (token: string) => string | null;
}

export interface WhisperRegistryOptions {
  /**
   * Slightly longer than the dial timeout. The carrier fetches this when the person
   * answers, which is at the very end of the ring, not the start.
   */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;

export const createWhisperRegistry = (options: WhisperRegistryOptions = {}): WhisperRegistry => {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const held = new Map<string, { line: string; expiresAt: number }>();

  const sweep = (): void => {
    const at = now();
    for (const [token, entry] of held) if (entry.expiresAt <= at) held.delete(token);
  };

  return {
    offer: (line) => {
      sweep();
      // 128 bits. Not a counter, not the call id, not a hash of anything the caller said.
      const token = randomBytes(16).toString("hex");
      held.set(token, { line, expiresAt: now() + ttlMs });
      return token;
    },

    take: (token) => {
      sweep();
      const entry = held.get(token);
      if (entry === undefined) return null;
      // Single use. A carrier retry gets nothing, which is the right trade: a second
      // fetch is far more likely to be someone else than a genuine redial.
      held.delete(token);
      return entry.line;
    },
  };
};
