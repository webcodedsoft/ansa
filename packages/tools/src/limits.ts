/**
 * R5.4.1. Chat tool calls can take five seconds; voice tool calls cannot.
 *
 * Both live here rather than in the dispatcher because registration also needs the hard
 * ceiling: a tenant configuring `timeoutMs: 30000` on their own HTTP connector would
 * otherwise buy thirty seconds of dead air on a phone line, and the place to refuse that
 * is registration, not the prompt.
 */

/** Past this, the caller needs to hear that something is still happening. */
export const SOFT_TIMEOUT_MS = 1500;

/** Past this the call is abandoned and the agent says so. Nothing may exceed it. */
export const HARD_TIMEOUT_MS = 3000;

/**
 * How long a spoken "yes" stays good for.
 *
 * A confirmation is scoped to one turn's worth of conversation. Two minutes later the
 * caller has moved on, and honouring the old yes would fire a write they have forgotten
 * agreeing to.
 */
export const CONFIRMATION_TTL_MS = 120_000;
