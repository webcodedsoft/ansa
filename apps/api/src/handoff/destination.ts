import type { HandoffDestination, Logger } from "@ansa/shared";

/**
 * The platform's fallback destination, read from the environment at boot.
 *
 * **A tenant's own destination wins over this.** Migration 0015 put escalation on the
 * tenant row where R6.5 always said it belonged, and `callSettings` prefers it; this is
 * what a deployment with one tenant and no rows filled in still gets. It is a fallback and
 * not a default in the ordinary sense: with two tenants configured, a call that lands here
 * is a call whose organisation has not said where its escalations go.
 *
 * Unconfigured returns null rather than a placeholder, and the escalation path says so out
 * loud. Today the agent says "let me get a colleague for you" and transfers nowhere; a
 * placeholder number would turn that from an honest dead end into a call that rings a
 * stranger.
 */

/** Long enough for a phone in a pocket, short enough that the caller has not given up. */
const DEFAULT_RING_SECONDS = 25;

const E164 = /^\+[1-9]\d{6,14}$/;

const clean = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
};

export const resolveHandoffDestination = (
  env: NodeJS.ProcessEnv,
  log: Logger,
): HandoffDestination | null => {
  const to = clean(env["HANDOFF_TO_NUMBER"]);
  const from = clean(env["HANDOFF_FROM_NUMBER"]);

  if (to === null || from === null) {
    // Info rather than error. An inbound-only deployment with no one to transfer to is a
    // real configuration, and it must not look like a fault every time the process boots.
    log.info("no handoff destination configured, escalation will say so rather than transfer");
    return null;
  }

  // Checked here rather than discovered at the carrier. A malformed number fails the REST
  // call at the exact moment a caller has been told they are being put through, which is
  // the worst possible time to learn about a typo in an environment variable.
  for (const [name, value] of [["HANDOFF_TO_NUMBER", to], ["HANDOFF_FROM_NUMBER", from]] as const) {
    if (!E164.test(value)) {
      log.error("handoff number is not E.164, escalation will not transfer", { name, value });
      return null;
    }
  }

  const ring = Number(env["HANDOFF_RING_SECONDS"] ?? DEFAULT_RING_SECONDS);
  return {
    to,
    from,
    ringSeconds: Number.isFinite(ring) && ring > 0 ? Math.round(ring) : DEFAULT_RING_SECONDS,
  };
};
