import type { RateLimitRule } from "./endpoint";

/**
 * A fixed-window counter, in memory.
 *
 * Two limitations worth stating rather than discovering: it is per process, so two API
 * instances allow twice the configured rate; and a window boundary allows a short burst
 * of up to twice the limit. Both are acceptable for what this protects — password
 * guessing and invitation-token guessing, where the useful property is turning millions
 * of attempts per minute into a handful, not enforcing an exact number.
 *
 * What it is not is a general traffic limiter. When the dashboard needs one of those it
 * belongs in front of the process, not inside it.
 */

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Whole seconds, for the `Retry-After` header. Zero when allowed. */
  readonly retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimiter {
  check(key: string, rule: RateLimitRule): RateLimitVerdict;
}

export const createRateLimiter = (now: () => number = Date.now): RateLimiter => {
  const windows = new Map<string, Window>();

  // Expired windows are swept on write rather than on a timer: the map only grows while
  // requests arrive, and a timer would keep an otherwise idle process awake.
  const sweep = (at: number): void => {
    if (windows.size < 4096) return;
    for (const [key, window] of windows) if (window.resetAt <= at) windows.delete(key);
  };

  return {
    check: (key, rule) => {
      const at = now();
      sweep(at);

      const window = windows.get(key);
      if (window === undefined || window.resetAt <= at) {
        windows.set(key, { count: 1, resetAt: at + rule.windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      window.count += 1;
      if (window.count <= rule.limit) return { allowed: true, retryAfterSeconds: 0 };
      return { allowed: false, retryAfterSeconds: Math.ceil((window.resetAt - at) / 1000) };
    },
  };
};
