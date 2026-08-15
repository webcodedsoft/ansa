/**
 * R5.2.3. One organization's broken endpoint must not degrade anyone else's calls.
 *
 * The failure this exists for is specific and it is not about the failing organization. Their
 * endpoint is down; their agent will say so either way. What matters is that every call
 * that touches it spends the full hard ceiling waiting — three seconds of a caller's time,
 * three seconds of a socket, and on a busy line enough concurrent waits to slow down the
 * event loop everybody else's audio is scheduled on. After a few of those, stopping fast
 * is both kinder to that organization's callers and the only thing that keeps it local to them.
 *
 * Keyed per organization *and* per tool. Per organization alone would let one broken connector
 * silence a working one beside it; per tool alone would let one organization's outage open the
 * circuit on another organization's tool of the same name, which is the exact cross-organization
 * coupling this requirement forbids.
 */

export interface CircuitBreaker {
  /** False while the circuit is open. The caller must not run the tool. */
  allows(key: string): boolean;
  succeeded(key: string): void;
  failed(key: string): void;
}

export interface BreakerOptions {
  /** Consecutive failures before the circuit opens. */
  readonly failureThreshold?: number;
  /** How long it stays open before one request is let through to test the water. */
  readonly openMs?: number;
  readonly now?: () => number;
}

interface State {
  failures: number;
  /** Null while closed. */
  openedAt: number | null;
}

/**
 * The key every caller must use, so organization and subject are never accidentally conflated.
 *
 * `subject` is a tool name today. Nothing in this file knows that, deliberately: the other
 * thing that will call an organisation's endpoint is event delivery (see TASKS.md, Slice
 * 6a), which is not a tool call and has no risk tier, but which fails in exactly the same
 * way and should be given up on for exactly the same reasons.
 */
export const breakerKey = (organizationId: string, subject: string): string => `${organizationId}::${subject}`;

export const createCircuitBreaker = (options: BreakerOptions = {}): CircuitBreaker => {
  const threshold = options.failureThreshold ?? 4;
  const openMs = options.openMs ?? 30_000;
  const now = options.now ?? Date.now;
  const states = new Map<string, State>();

  return {
    allows(key) {
      const state = states.get(key);
      if (state === undefined || state.openedAt === null) return true;
      if (now() - state.openedAt < openMs) return false;
      // Half open: exactly one request goes through. Moving the window forward is what
      // makes it exactly one — a second caller arriving in the same millisecond is still
      // refused, rather than every queued call being released at once into an endpoint
      // that is probably still down.
      state.openedAt = now();
      return true;
    },

    succeeded(key) {
      states.delete(key);
    },

    failed(key) {
      const state = states.get(key) ?? { failures: 0, openedAt: null };
      state.failures += 1;
      if (state.openedAt !== null || state.failures >= threshold) {
        state.openedAt = now();
        state.failures = 0;
      }
      states.set(key, state);
    },
  };
};
