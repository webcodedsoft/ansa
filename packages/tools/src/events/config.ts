import { requireAllowed } from "../connector/config";
import { parseRedactionPolicy, type RedactionPolicy } from "../redaction";

import type { EgressPolicy } from "../connector/egress";

/**
 * What an organisation writes down to have its own data pushed to it (Slice 6a).
 *
 * This is not a tool and the difference is not cosmetic. A tool call is decided by the
 * model in the middle of a conversation, is on the latency budget, and has a risk tier
 * because something is being done to the caller. An event is decided by the platform at a
 * lifecycle point, happens after the fact, and must never touch the call. Registering
 * events into the tool registry would put a delivery on the conversation's critical path
 * and let the model decide whether an organisation receives its own data — wrong in both
 * directions at once.
 *
 * So it is a different key in organization configuration and a different validator, and it
 * deliberately reuses everything below the seam: the egress allowlist, the credential
 * vault, the address-pinning transport and the circuit breaker are the Slice 6 ones. There
 * is one outbound HTTP path in this product and this is not a second one.
 */

/**
 * The lifecycle points that push.
 *
 * Two, because two are proven: a call ending and a call being handed to a person. Both
 * already have a payload that something else needed first — the call record and the
 * handoff summary — which is why they are the two that are honest to ship. Adding a third
 * means adding a payload builder, not a mechanism.
 */
export type EventType = "call.ended" | "call.transferred";

export const EVENT_TYPES: readonly EventType[] = ["call.ended", "call.transferred"];

export interface EventSubscription {
  /** The organization's own name for this receiver. Appears in the delivery log they are shown. */
  readonly name: string;
  readonly url: string;
  readonly events: readonly EventType[];
  /**
   * The shared secret this receiver verifies with. Required, and deliberately so: an
   * endpoint that accepts an unsigned POST accepts one from anybody who learns the URL.
   */
  readonly signingSecretRef: string;
  /** Optional auth on top of the signature, for a receiver that wants a header too. */
  readonly credentialRef?: string;
  /**
   * How long one attempt may take.
   *
   * Generous compared with a tool call, and that is the point of the whole slice: nobody
   * is waiting. The voice budget's three-second ceiling has no meaning here.
   */
  readonly timeoutMs: number;
  /** Attempts before the delivery is given up on and recorded as failed. */
  readonly maxAttempts: number;
  /**
   * This receiver's masking rules, or the organization's, or none.
   *
   * Per subscription as well as per organization because the same organisation reasonably wants
   * its own CRM to get the policy number and an analytics vendor not to.
   */
  readonly redaction: RedactionPolicy;
}

export interface EventConfig {
  /** R5.2.2, and the same allowlist semantics as tools. A organization declares its receivers. */
  readonly egress: EgressPolicy;
  readonly subscriptions: readonly EventSubscription[];
}

const NO_EVENT_CONFIG: EventConfig = { egress: { allowedHosts: [] }, subscriptions: [] };

/** Long enough for a receiver that writes to its own database before answering. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** With the backoff below, eight attempts spans a little over an hour. */
const DEFAULT_MAX_ATTEMPTS = 8;
const MAX_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS_CEILING = 20;

const asRecord = (value: unknown, where: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`event config: ${where} must be an object`);
  }
  return value as Record<string, unknown>;
};

const asText = (value: unknown, where: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`event config: ${where} must be a non-empty string`);
  }
  return value.trim();
};

const asBounded = (value: unknown, where: string, fallback: number, cap: number): number => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > cap) {
    throw new Error(`event config: ${where} must be a whole number between 1 and ${cap}`);
  }
  return value;
};

const asEvents = (value: unknown, where: string): readonly EventType[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`event config: ${where}.events must list at least one event type`);
  }
  const chosen: EventType[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "string" || !EVENT_TYPES.includes(entry as EventType)) {
      throw new Error(
        `event config: ${where}.events has an unknown type; allowed: ${EVENT_TYPES.join(", ")}`,
      );
    }
    if (!chosen.includes(entry as EventType)) chosen.push(entry as EventType);
  }
  return chosen;
};

const parseSubscription = (
  value: unknown,
  index: number,
  organizationRedaction: RedactionPolicy,
): EventSubscription => {
  const where = `subscriptions[${index}]`;
  const raw = asRecord(value, where);

  const credentialRef =
    raw.credentialRef === undefined || raw.credentialRef === null
      ? undefined
      : asText(raw.credentialRef, `${where}.credentialRef`);

  return {
    name: asText(raw.name, `${where}.name`),
    url: asText(raw.url, `${where}.url`),
    events: asEvents(raw.events, where),
    signingSecretRef: asText(raw.signingSecretRef, `${where}.signingSecretRef`),
    ...(credentialRef === undefined ? {} : { credentialRef }),
    timeoutMs: asBounded(raw.timeoutMs, `${where}.timeoutMs`, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxAttempts: asBounded(
      raw.maxAttempts,
      `${where}.maxAttempts`,
      DEFAULT_MAX_ATTEMPTS,
      MAX_ATTEMPTS_CEILING,
    ),
    // The organization's rules unless this receiver names its own. Absent everywhere means the
    // organisation gets its own data complete, which is the default this slice defends.
    redaction:
      raw.redaction === undefined || raw.redaction === null
        ? organizationRedaction
        : parseRedactionPolicy(raw.redaction, `${where}.redaction`),
  };
};

/**
 * Stored configuration in, configuration this package will act on out.
 *
 * Throws rather than dropping a bad entry, for the same reason the tool config validator
 * does: a subscription that silently fails to register is an organisation wondering why
 * their CRM has been empty since Tuesday, and the error belongs at publication time where
 * somebody is looking at a screen.
 */
export const parseEventConfig = (value: unknown): EventConfig => {
  if (value === undefined || value === null) return NO_EVENT_CONFIG;
  const raw = asRecord(value, "event config");

  const egressRaw = raw.egress === undefined ? {} : asRecord(raw.egress, "event config.egress");
  const hosts = egressRaw.allowedHosts;
  if (hosts !== undefined && !Array.isArray(hosts)) {
    throw new Error("event config: egress.allowedHosts must be an array of hostnames");
  }

  const subscriptions = raw.subscriptions === undefined ? [] : raw.subscriptions;
  if (!Array.isArray(subscriptions)) {
    throw new Error("event config: subscriptions must be an array");
  }

  const organizationRedaction = parseRedactionPolicy(raw.redaction, "event config.redaction");

  const parsed: EventConfig = {
    egress: {
      allowedHosts: (hosts ?? []).map((host, index) =>
        asText(host, `event config.egress.allowedHosts[${index}]`),
      ),
      allowPlaintextHttp: egressRaw.allowPlaintextHttp === true,
    },
    subscriptions: (subscriptions as unknown[]).map((entry, index) =>
      parseSubscription(entry, index, organizationRedaction),
    ),
  };

  // Same check and same reasoning as the tool config: a receiver outside the allowlist the
  // organization declared beside it is refused by the guard on every attempt, and it should be a
  // publication error rather than a delivery that never arrives and nobody watches.
  for (const subscription of parsed.subscriptions) {
    requireAllowed(subscription.url, parsed.egress, `event config.${subscription.name}.url`);
  }

  return parsed;
};

/** Which of a organization's receivers asked for this event. */
export const subscribersTo = (
  config: EventConfig,
  type: EventType,
): readonly EventSubscription[] => config.subscriptions.filter((s) => s.events.includes(type));
