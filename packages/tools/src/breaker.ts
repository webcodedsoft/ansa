/**
 * R5.2.3. One tenant's broken endpoint must not degrade anyone else's calls.
 *
 * The failure this exists for is specific and it is not about the failing tenant. Their
 * endpoint is down; their agent will say so either way. What matters is that every call
 * that touches it spends the full hard ceiling waiting — three seconds of a caller's time,
 * three seconds of a socket, and on a busy line enough concurrent waits to slow down the
 * event loop everybody else's audio is scheduled on. After a few of those, stopping fast
 * is both kinder to that tenant's callers and the only thing that keeps it local to them.
 *
 * Keyed per tenant *and* per tool. Per tenant alone would let one broken connector
 * silence a working one beside it; per tool alone would let one tenant's outage open the
 * circuit on another tenant's tool of the same name, which is the exact cross-tenant
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

/** The key every caller must use, so tenant and tool are never accidentally conflated. */
export const breakerKey = (tenantId: string, tool: string): string => `${tenantId}::${tool}`;

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
