import type { OnboardingFacts } from "@ansa/db";
import { parseConnectorConfig, parseEventConfig } from "@ansa/tools";

import type { NumbersEnvironment } from "./environment";
import type { VoiceProbe, WebhookProbe } from "./probes";
import { clamp } from "./text";

/**
 * "Is this organisation actually live, and if not what is missing?"
 *
 * Pure: facts in, verdict out, no I/O. Everything that needed a database or a vendor has
 * already happened by the time this runs, so the whole of the judgement is testable without
 * either — which matters, because the judgement is the part that will be argued with.
 *
 * The checks are not a checklist somebody wrote down. Each one is a failure that has
 * actually happened, most of them recorded in `docs/ONBOARDING_RUNBOOK.md` after onboarding
 * the second tenant by hand:
 *
 *   - a carrier webhook nobody checked, on a tenant that looked perfect in every column;
 *   - a voice id that published happily and hung up the first call;
 *   - a missing vault key that failed loudly at sealing and *silently* at publish, leaving
 *     a tenant's tools dropped on every call with an error in a log nobody watches;
 *   - an egress allowlist entry with a port in it, which matches no host and never fires.
 *
 * Three states carry the whole meaning, and the difference between the last two is the
 * reason this is worth building rather than printing the tenant row:
 *
 *   `blocked`   a caller is being failed today, or would be by the next call.
 *   `attention` it works, and it is probably not what they meant.
 *   `unknown`   it cannot be decided from this process, and the reason says why.
 *
 * `unknown` is never quietly upgraded to `ok`. A check that cannot be run has not passed,
 * and the one thing worse than an unwired number is a dashboard saying it is wired.
 */

export const CHECK_IDS = [
  "number.attached",
  "number.carrier_webhook",
  "number.traffic",
  "greeting",
  "voice",
  "consent_policy",
  "business_hours",
  "tools",
  "credentials",
  "events",
  "escalation",
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

export const CHECK_STATES = ["ok", "attention", "blocked", "unknown"] as const;

export type CheckState = (typeof CHECK_STATES)[number];

export interface ReadinessCheck {
  readonly id: CheckId;
  /** One line, for a list. The detail says why. */
  readonly title: string;
  readonly state: CheckState;
  readonly detail: string;
  /** What to do about it, or null when there is nothing to do. */
  readonly remedy: string | null;
}

export interface ReadinessReport {
  /** True when nothing is `blocked`. An `unknown` does not make an organisation live. */
  readonly live: boolean;
  readonly configVersion: number;
  readonly checks: readonly ReadinessCheck[];
}

export interface ReadinessInput {
  readonly facts: OnboardingFacts;
  readonly environment: NumbersEnvironment;
  readonly webhook: WebhookProbe;
  readonly voice: VoiceProbe;
}

/** The shape the carrier reports a dialled number in, and resolution is an exact match. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * The bounds the response schema in `readiness.controller.ts` declares.
 *
 * Enforced here rather than trusted, because several of these sentences quote something an
 * organisation wrote — a tool name, a credential reference, a parser message about their
 * own document — and a response that overruns its schema is answered as a 500. A readiness
 * endpoint that falls over on a long configuration would fail at exactly the moment it is
 * being asked why the configuration is wrong.
 */
const DETAIL_LIMIT = 1200;
const REMEDY_LIMIT = 600;

const check = (
  id: CheckId,
  title: string,
  state: CheckState,
  detail: string,
  remedy: string | null = null,
): ReadinessCheck => ({
  id,
  title,
  state,
  detail: clamp(detail, DETAIL_LIMIT),
  remedy: remedy === null ? null : clamp(remedy, REMEDY_LIMIT),
});

// ---------------------------------------------------------------------------
// The number
// ---------------------------------------------------------------------------

const attachedCheck = (facts: OnboardingFacts): ReadinessCheck => {
  const number = facts.dialledNumber;
  if (number === null) {
    return check(
      "number.attached",
      "A number is attached",
      "blocked",
      "No number is attached to this organisation. An inbound call is routed by the number the caller dialled, so there is nothing for a caller to ring.",
      "Attaching a number is done by an operator, not from here. GET /api/v1/numbers/provisioning says why, and what is needed.",
    );
  }
  if (!E164.test(number)) {
    return check(
      "number.attached",
      "A number is attached",
      "attention",
      `The attached number is stored as "${number}", which is not E.164. The carrier reports the dialled number in E.164 and the tenant is resolved by an exact string match, so a call to this number will not resolve to this organisation.`,
      "An operator corrects the stored number to its E.164 form, leading plus and no separators.",
    );
  }
  return check("number.attached", "A number is attached", "ok", `Inbound calls resolve on ${number}.`);
};

const webhookCheck = (probe: WebhookProbe): ReadinessCheck => {
  const title = "The carrier sends that number here";
  const expected = probe.expected;
  const point = expected === null ? "the voice webhook" : `the voice webhook at ${expected}`;

  switch (probe.state) {
    case "matches":
      return check("number.carrier_webhook", title, "ok", `The carrier posts inbound calls to ${expected}.`);
    case "points-elsewhere":
      return check(
        "number.carrier_webhook",
        title,
        "blocked",
        `The carrier posts inbound calls to ${probe.observed}, which is not this deployment. Calls to this number never reach the agent.`,
        `Point the number's voice webhook at ${expected} with method POST.`,
      );
    case "not-set":
      return check(
        "number.carrier_webhook",
        title,
        "blocked",
        "The carrier holds this number and no voice webhook is set on it, so a call to it reaches nothing.",
        `Set the number's voice webhook to ${expected} with method POST.`,
      );
    case "not-in-carrier-account":
    case "unchecked":
      return check(
        "number.carrier_webhook",
        title,
        "unknown",
        // The ordinary case for a Nigerian number, and the single largest gap in what this
        // endpoint can prove. Step 1 of the onboarding runbook is the one most often
        // forgotten and it is invisible from here.
        `${probe.reason ?? "This check did not run."} Nothing in this deployment can confirm the number is wired, so this has to be confirmed at the carrier.`,
        `Confirm at the carrier that the number's voice webhook is ${point}, method POST.`,
      );
  }
};

/**
 * The cheapest evidence in the product that the carrier is wired, and the only one that
 * works for a number no API of ours can see.
 *
 * A tenant provisioned with step 1 forgotten has a perfect configuration and no rows in
 * `calls`, for ever. This does not prove wiring — a new tenant has no traffic either — but
 * an organisation that has been configured for a week and never received a call is the
 * exact shape of that mistake.
 */
const trafficCheck = (facts: OnboardingFacts): ReadinessCheck => {
  const title = "A call has reached us on it";
  if (facts.callsReceived === 0) {
    return check(
      "number.traffic",
      title,
      "attention",
      "No call has ever been announced to this deployment for this organisation. That is expected before the first test call and is the symptom of a carrier webhook that was never set.",
      "Dial the number. Nothing above this proves anything until a call arrives.",
    );
  }
  return check(
    "number.traffic",
    title,
    "ok",
    `${facts.callsReceived} call${facts.callsReceived === 1 ? "" : "s"} received; the most recent at ${facts.lastCallAt ?? "an unrecorded time"}.`,
  );
};

// ---------------------------------------------------------------------------
// What the caller hears
// ---------------------------------------------------------------------------

const greetingCheck = (facts: OnboardingFacts): ReadinessCheck => {
  const title = "The greeting is this organisation's own";
  if (facts.greeting === null) {
    return check(
      "greeting",
      title,
      "attention",
      "No greeting is configured, so callers hear the platform's. It names no organisation, which is a working call and an odd first sentence.",
      "Publish a greeting in this organisation's own words.",
    );
  }
  return check("greeting", title, "ok", "Callers hear this organisation's own first sentence.");
};

const voiceCheck = (probe: VoiceProbe): ReadinessCheck => {
  const title = "The configured voice resolves";
  switch (probe.state) {
    case "known":
      return check(
        "voice",
        title,
        "ok",
        probe.source === "organisation"
          ? "The speech account resolves this organisation's voice."
          : "This organisation has configured no voice, and the platform's fallback resolves.",
      );
    case "unknown-to-account":
      return check(
        "voice",
        title,
        "blocked",
        // The runbook's worst failure: publishes happily, synthesises nothing, retries once,
        // hangs up. Correct behaviour on the call — an open silent line is worse — and it is
        // discovered by a caller, which is the part this exists to prevent.
        "The speech account does not resolve the configured voice id. Every call would synthesise nothing, retry once and end.",
        "Publish a voice id the speech account holds.",
      );
    case "none-configured":
      return check(
        "voice",
        title,
        "blocked",
        "No voice is configured for this organisation and this deployment has no fallback, so nothing can be spoken.",
        "Publish a voice id.",
      );
    case "unchecked":
      return check(
        "voice",
        title,
        "unknown",
        `${probe.reason ?? "This check did not run."} A wrong voice id publishes without complaint and ends the first call that uses it.`,
        "Confirm the voice by placing a call.",
      );
  }
};

// ---------------------------------------------------------------------------
// What the operator set, and what the organisation chose
// ---------------------------------------------------------------------------

const consentCheck = (facts: OnboardingFacts): ReadinessCheck => {
  const title = "A consent policy is recorded";
  const policy = facts.consentPolicy;
  if (policy === null) {
    return check(
      "consent_policy",
      title,
      "unknown",
      "This deployment's tenant row has no consent policy column, which means a migration has not been applied.",
      "Apply the outstanding database migrations.",
    );
  }
  if (policy === "existing_relationship" && facts.consentBasis === null) {
    return check(
      "consent_policy",
      title,
      "blocked",
      "The policy claims a standing relationship and no basis is recorded for it.",
      "An operator records the lawful basis. Organisations choose their basis; they do not choose whether one is required.",
    );
  }
  return check(
    "consent_policy",
    title,
    "ok",
    facts.consentBasis === null
      ? `The policy is "${policy}", with no stated basis, which is the strict default. It gates outbound calling and has no effect on the inbound line.`
      : `The policy is "${policy}", with a basis recorded.`,
  );
};

const hoursCheck = (facts: OnboardingFacts): ReadinessCheck => {
  const title = "Business hours are settled";
  if (facts.businessHours !== null) {
    return check("business_hours", title, "ok", "The agent can answer when the organisation's own line is staffed.");
  }
  return check(
    "business_hours",
    title,
    "attention",
    // Not a fault. Unset is a supported and honest configuration, and inventing a plausible
    // nine to five would be the same failure as answering from records nobody wrote.
    "No business hours are set, so the agent answers that it does not know the opening hours. That is honest and may be deliberate; it is listed because it is more often forgotten than chosen.",
    "Publish business hours, or accept that the agent says it does not know them.",
  );
};

const escalationCheck = (
  facts: OnboardingFacts,
  environment: NumbersEnvironment,
): ReadinessCheck => {
  const title = "An escalation has somewhere to go";
  if (facts.escalationConfigured) {
    return check("escalation", title, "ok", "A caller who asks for a person is transferred to this organisation's own number.");
  }
  if (environment.platformHandoff) {
    return check(
      "escalation",
      title,
      "attention",
      "This organisation has no escalation number, so a caller asking for a person is transferred to the platform's — which is somebody else's phone once there is more than one organisation on this deployment.",
      "Publish an escalation destination of this organisation's own.",
    );
  }
  return check(
    "escalation",
    title,
    "blocked",
    "This organisation has no escalation number and this deployment has no fallback, so a caller who asks for a person is apologised to and hung up on.",
    "Publish an escalation destination.",
  );
};

// ---------------------------------------------------------------------------
// Tools, credentials and events
// ---------------------------------------------------------------------------

/**
 * The published documents, parsed exactly as config load parses them.
 *
 * This is the whole point of re-parsing rather than reading a summary column: a document
 * that throws here is a document that throws on every call, where `prepareConnectors` and
 * `prepareEvents` catch it, log it and return nothing. The organisation keeps a published
 * version full of tools and an agent that has none.
 */
interface ParsedConfig {
  readonly toolNames: readonly string[];
  readonly eventNames: readonly string[];
  /** Every credential and signing-secret name the two documents refer to. */
  readonly requiredRefs: readonly string[];
  readonly toolError: string | null;
  readonly eventError: string | null;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const parseConfigs = (facts: OnboardingFacts): ParsedConfig => {
  const toolNames: string[] = [];
  const eventNames: string[] = [];
  const requiredRefs: string[] = [];
  let toolError: string | null = null;
  let eventError: string | null = null;

  if (facts.toolConfig != null) {
    try {
      const tools = parseConnectorConfig(facts.toolConfig);
      for (const tool of tools.http) {
        toolNames.push(tool.name);
        if (tool.credentialRef !== undefined) requiredRefs.push(tool.credentialRef);
      }
      for (const server of tools.mcp) {
        for (const tool of server.tools) toolNames.push(tool.name);
        if (server.credentialRef !== undefined) requiredRefs.push(server.credentialRef);
      }
    } catch (error) {
      toolError = messageOf(error);
    }
  }

  if (facts.eventConfig != null) {
    try {
      const events = parseEventConfig(facts.eventConfig);
      for (const subscription of events.subscriptions) {
        eventNames.push(subscription.name);
        requiredRefs.push(subscription.signingSecretRef);
        if (subscription.credentialRef !== undefined) requiredRefs.push(subscription.credentialRef);
      }
    } catch (error) {
      eventError = messageOf(error);
    }
  }

  return {
    toolNames,
    eventNames,
    requiredRefs: [...new Set(requiredRefs)].sort(),
    toolError,
    eventError,
  };
};

const toolsCheck = (facts: OnboardingFacts, parsed: ParsedConfig): ReadinessCheck => {
  const title = "The organisation's own tools are usable";
  if (parsed.toolError !== null) {
    return check(
      "tools",
      title,
      "blocked",
      `The published tool configuration does not parse, so every call runs with no tools of this organisation's at all: ${parsed.toolError}`,
      "Publish a corrected tool configuration.",
    );
  }
  if (facts.toolConfig == null) {
    return check(
      "tools",
      title,
      "ok",
      "No tools are configured. The agent can talk, end a call, transfer to a person and answer about opening hours, and says it cannot check anything else.",
    );
  }
  if (parsed.toolNames.length === 0) {
    return check(
      "tools",
      title,
      "attention",
      "A tool configuration is published and it registers nothing. That is the same agent as no configuration at all, which is unlikely to be what was meant.",
      "Publish the tools, or remove the empty document.",
    );
  }
  return check("tools", title, "ok", `${parsed.toolNames.length} tool${parsed.toolNames.length === 1 ? "" : "s"} registered: ${parsed.toolNames.join(", ")}.`);
};

/**
 * The silent one.
 *
 * Sealing a credential refuses loudly without the vault key; publishing does not. A
 * configuration full of tools publishes fine, and every one that names a credential is
 * dropped at config load with an error in a log nobody is watching. The second tenant's
 * first published version was in exactly that state.
 */
const credentialsCheck = (
  facts: OnboardingFacts,
  environment: NumbersEnvironment,
  parsed: ParsedConfig,
): ReadinessCheck => {
  const title = "Every credential a tool names is sealed and openable";
  if (parsed.toolError !== null || parsed.eventError !== null) {
    return check(
      "credentials",
      title,
      "unknown",
      "A published document does not parse, so which credentials it needs cannot be determined.",
      "Fix the configuration above; this check answers once it parses.",
    );
  }
  if (parsed.requiredRefs.length === 0) {
    return check("credentials", title, "ok", "Nothing in this configuration names a credential.");
  }
  if (environment.credentialKey === "absent") {
    return check(
      "credentials",
      title,
      "blocked",
      `This deployment holds no vault key, so the ${parsed.requiredRefs.length} credential${parsed.requiredRefs.length === 1 ? "" : "s"} this configuration names cannot be opened. Every tool and every event receiver that needs one is dropped at config load — silently, on every call.`,
      "Set TOOL_CREDENTIAL_KEY on the process that answers calls.",
    );
  }
  if (environment.credentialKey === "malformed") {
    return check(
      "credentials",
      title,
      "blocked",
      "This deployment's vault key is not 32 bytes, so no credential can be opened. The call process refuses to boot in this state.",
      "Set TOOL_CREDENTIAL_KEY to 32 bytes, base64.",
    );
  }

  const held = new Set(facts.credentialRefs);
  const missing = parsed.requiredRefs.filter((ref) => !held.has(ref));
  if (missing.length > 0) {
    return check(
      "credentials",
      title,
      "blocked",
      `The configuration names ${missing.length} credential${missing.length === 1 ? "" : "s"} the vault does not hold: ${missing.join(", ")}. An event receiver naming one is dropped at config load; a tool naming one fails when a caller asks for it.`,
      "Seal the missing references before publishing the configuration that uses them.",
    );
  }
  return check(
    "credentials",
    title,
    "ok",
    `All ${parsed.requiredRefs.length} referenced credential${parsed.requiredRefs.length === 1 ? " is" : "s are"} sealed and the vault key is present.`,
  );
};

/**
 * Configured, signable, and — as far as anything read-only can say — being delivered to.
 *
 * Reachability is deliberately not probed. The only honest probe is a request to somebody
 * else's endpoint, which is a side effect on a third party's system dressed as a health
 * check. The delivery history answers the same question with evidence rather than traffic.
 */
const eventsCheck = (facts: OnboardingFacts, parsed: ParsedConfig): ReadinessCheck => {
  const title = "Event receivers are configured and being delivered to";
  if (parsed.eventError !== null) {
    return check(
      "events",
      title,
      "blocked",
      `The published event configuration does not parse, so nothing is delivered anywhere: ${parsed.eventError}`,
      "Publish a corrected event configuration.",
    );
  }
  if (facts.eventConfig == null || parsed.eventNames.length === 0) {
    return check(
      "events",
      title,
      "ok",
      "No event receiver is configured. Nothing is pushed anywhere, which is a complete configuration.",
    );
  }
  if (facts.failedDeliveries > 0) {
    return check(
      "events",
      title,
      "attention",
      `${parsed.eventNames.length} receiver${parsed.eventNames.length === 1 ? "" : "s"} configured (${parsed.eventNames.join(", ")}), and ${facts.failedDeliveries} deliver${facts.failedDeliveries === 1 ? "y has" : "ies have"} been given up on. Whether a receiver is reachable is not checked from here; this is what actually happened.`,
      "Read the delivery log for what was sent and what came back.",
    );
  }
  return check(
    "events",
    title,
    "ok",
    `${parsed.eventNames.length} receiver${parsed.eventNames.length === 1 ? "" : "s"} configured (${parsed.eventNames.join(", ")}), no failed deliveries${facts.pendingDeliveries > 0 ? `, ${facts.pendingDeliveries} still retrying` : ""}. Reachability is not probed — sending a request to somebody's endpoint to see if it answers is a side effect, not a health check.`,
  );
};

export const evaluateReadiness = (input: ReadinessInput): ReadinessReport => {
  const { facts, environment } = input;
  const parsed = parseConfigs(facts);

  const checks: readonly ReadinessCheck[] = [
    attachedCheck(facts),
    webhookCheck(input.webhook),
    trafficCheck(facts),
    greetingCheck(facts),
    voiceCheck(input.voice),
    consentCheck(facts),
    hoursCheck(facts),
    toolsCheck(facts, parsed),
    credentialsCheck(facts, environment, parsed),
    eventsCheck(facts, parsed),
    escalationCheck(facts, environment),
  ];

  return {
    live: checks.every((entry) => entry.state !== "blocked"),
    configVersion: facts.configVersion,
    checks,
  };
};
