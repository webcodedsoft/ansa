import { randomBytes } from "node:crypto";

/**
 * A short-lived, single-use ticket to one call's audio.
 *
 * The same shape as the handoff whisper registry, for the same reason and one more. An
 * `<audio>` element cannot send an authorization header, so the URL is the only credential it
 * can carry — which means the URL has to be unguessable, expire quickly, and work once. A
 * predictable one, the call id say, would let anyone who can reach the deployment listen to a
 * caller they have nothing to do with.
 *
 * Single use is the part worth defending. A player that re-requests on seek would spend the
 * ticket, so the route serves the whole file in one response rather than by range — a recorded
 * call is a few hundred kilobytes, and streaming it is not worth a reusable credential.
 *
 * In memory on purpose. A ticket outliving a restart would be a credential in a table with a
 * retention policy nobody wrote, and losing one costs a click.
 */
export interface RecordingLinks {
  /** The token to put in the URL. Whether the call may be heard is checked before this. */
  readonly offer: (callId: string) => string;
  /** Null when unknown, expired, or already spent. */
  readonly take: (token: string) => string | null;
}

export interface RecordingLinkOptions {
  /** Long enough to click and start playing, short enough that a leaked URL is worthless. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 120_000;

export const createRecordingLinks = (options: RecordingLinkOptions = {}): RecordingLinks => {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const held = new Map<string, { callId: string; expiresAt: number }>();

  const sweep = (): void => {
    const at = now();
    for (const [token, entry] of held) if (entry.expiresAt <= at) held.delete(token);
  };

  return {
    offer: (callId) => {
      sweep();
      // 128 bits. Not a counter, not the call id, not derived from anything about the call.
      const token = randomBytes(16).toString("hex");
      held.set(token, { callId, expiresAt: now() + ttlMs });
      return token;
    },

    take: (token) => {
      sweep();
      const entry = held.get(token);
      if (entry === undefined) return null;
      held.delete(token);
      return entry.callId;
    },
  };
};
