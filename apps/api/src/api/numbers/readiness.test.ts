import type { OnboardingFacts } from "@ansa/db";
import { describe, expect, it } from "vitest";

import type { NumbersEnvironment } from "./environment";
import type { VoiceProbe, WebhookProbe } from "./probes";
import { CHECK_IDS, evaluateReadiness, type CheckId, type CheckState } from "./readiness";

/**
 * The judgement, tested without a database, a carrier or a speech account — which is the
 * reason it is a pure function.
 *
 * Each case below is a failure mode from `docs/ONBOARDING_RUNBOOK.md` or from the schema
 * itself, and the assertion is on the state rather than on the wording, because the wording
 * will be edited and the verdict must not change when it is.
 */

const FACTS: OnboardingFacts = {
  organisationName: "An organisation",
  dialledNumber: "+2348000000000",
  greeting: "Good afternoon.",
  voiceId: "a-voice",
  businessHours: { opensAtHour: 8, closesAtHour: 17, openDays: [1, 2, 3, 4, 5] },
  consentPolicy: "per_number",
  consentBasis: null,
  escalationConfigured: true,
  toolConfig: null,
  eventConfig: null,
  credentialRefs: [],
  configVersion: 3,
  callsReceived: 4,
  lastCallAt: "2026-08-01T10:00:00.000Z",
  failedDeliveries: 0,
  pendingDeliveries: 0,
};

const ENVIRONMENT: NumbersEnvironment = {
  publicBaseUrl: "https://ansa.example",
  carrier: null,
  voice: null,
  platformVoiceId: null,
  credentialKey: "present",
  platformHandoff: true,
};

const WEBHOOK_OK: WebhookProbe = {
  state: "matches",
  expected: "https://ansa.example/telephony/voice",
  observed: "https://ansa.example/telephony/voice",
  reason: null,
};

const VOICE_OK: VoiceProbe = { state: "known", voiceId: "a-voice", source: "organisation", reason: null };

const report = (
  facts: Partial<OnboardingFacts> = {},
  environment: Partial<NumbersEnvironment> = {},
  webhook: WebhookProbe = WEBHOOK_OK,
  voice: VoiceProbe = VOICE_OK,
): ReturnType<typeof evaluateReadiness> =>
  evaluateReadiness({
    facts: { ...FACTS, ...facts },
    environment: { ...ENVIRONMENT, ...environment },
    webhook,
    voice,
  });

const stateOf = (
  id: CheckId,
  facts: Partial<OnboardingFacts> = {},
  environment: Partial<NumbersEnvironment> = {},
  webhook?: WebhookProbe,
  voice?: VoiceProbe,
): CheckState => {
  const found = report(facts, environment, webhook, voice).checks.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no check ${id} in the report`);
  return found.state;
};

const detailOf = (id: CheckId, facts: Partial<OnboardingFacts> = {}): string => {
  const found = report(facts).checks.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no check ${id} in the report`);
  return found.detail;
};

describe("the readiness report", () => {
  it("answers every declared check, once each, in a stable order", () => {
    const ids = report().checks.map((entry) => entry.id);
    expect(ids).toEqual([...CHECK_IDS]);
  });

  it("is live when a fully configured organisation is checked", () => {
    expect(report().live).toBe(true);
  });

  /**
   * The assertion the whole design rests on. `unknown` is not a pass: an organisation whose
   * carrier wiring cannot be read is not thereby wired, and this must not report it as one —
   * but it is also not evidence of a fault, so it does not make them not-live either.
   */
  it("does not treat an unanswerable check as a failure or as a pass", () => {
    const unknowable = report({}, {}, {
      state: "not-in-carrier-account",
      expected: "https://ansa.example/telephony/voice",
      observed: null,
      reason: "not in the twilio account",
    });
    expect(unknowable.live).toBe(true);
    expect(unknowable.checks.find((entry) => entry.id === "number.carrier_webhook")?.state).toBe(
      "unknown",
    );
  });

  it("reports the configuration version the answers were read from", () => {
    expect(report({ configVersion: 11 }).configVersion).toBe(11);
  });

  /**
   * The response is projected through its schema and a value that overruns it is answered
   * as a 500. Several details quote something an organisation wrote, so an organisation
   * with a great many tools must not be the one that takes this endpoint down.
   */
  it("keeps every sentence inside the bound its response schema declares", () => {
    const manyTools = {
      egress: { allowedHosts: ["api.tenant.test"] },
      http: Array.from({ length: 80 }, (_unused, index) => ({
        name: `look_up_a_thing_number_${index}`,
        description: "Look something up",
        parameters: { type: "object", properties: {} },
        riskTier: "read",
        route: "http",
        url: "https://api.tenant.test/thing",
        method: "GET",
        send: "query",
        speech: { template: "It is {status}.", fallback: "I could not find it." },
        credentialRef: `credential_number_${index}`,
      })),
    };

    for (const entry of report({ toolConfig: manyTools, credentialRefs: [] }).checks) {
      expect(entry.detail.length, entry.id).toBeLessThanOrEqual(1200);
      expect(entry.remedy?.length ?? 0, entry.id).toBeLessThanOrEqual(600);
      expect(entry.title.length, entry.id).toBeLessThanOrEqual(120);
    }
  });
});

describe("the number", () => {
  it("blocks when nothing is attached", () => {
    expect(stateOf("number.attached", { dialledNumber: null })).toBe("blocked");
    expect(report({ dialledNumber: null }).live).toBe(false);
  });

  /**
   * A number stored in any other form resolves nothing, because `app.tenant_for_number`
   * compares the carrier's E.164 string exactly. It looks entirely correct in the column.
   */
  it("flags a number that is not E.164, because resolution is an exact match", () => {
    expect(stateOf("number.attached", { dialledNumber: "08000000000" })).toBe("attention");
  });

  it("blocks when the carrier sends the number's calls somewhere else", () => {
    expect(
      stateOf("number.carrier_webhook", {}, {}, {
        state: "points-elsewhere",
        expected: "https://ansa.example/telephony/voice",
        observed: "https://somewhere.else/voice",
        reason: null,
      }),
    ).toBe("blocked");
  });

  it("blocks when the carrier holds the number with no webhook on it at all", () => {
    expect(
      stateOf("number.carrier_webhook", {}, {}, {
        state: "not-set",
        expected: "https://ansa.example/telephony/voice",
        observed: null,
        reason: null,
      }),
    ).toBe("blocked");
  });

  /** The runbook's most likely onboarding mistake, and the only evidence available for it. */
  it("notices that no call has ever arrived", () => {
    expect(stateOf("number.traffic", { callsReceived: 0, lastCallAt: null })).toBe("attention");
  });
});

describe("what the caller hears", () => {
  it("flags a missing greeting without calling it broken", () => {
    expect(stateOf("greeting", { greeting: null })).toBe("attention");
  });

  /** Publishes happily; ends the first call that uses it. That is a block, not a warning. */
  it("blocks a voice id the speech account does not resolve", () => {
    expect(
      stateOf("voice", {}, {}, undefined, {
        state: "unknown-to-account",
        voiceId: "wrong",
        source: "organisation",
        reason: null,
      }),
    ).toBe("blocked");
  });

  it("blocks when there is no voice anywhere, not even a platform fallback", () => {
    expect(
      stateOf("voice", {}, {}, undefined, {
        state: "none-configured",
        voiceId: null,
        source: "none",
        reason: null,
      }),
    ).toBe("blocked");
  });

  it("reports an unverifiable voice as unknown rather than passing it", () => {
    expect(
      stateOf("voice", {}, {}, undefined, {
        state: "unchecked",
        voiceId: "a-voice",
        source: "organisation",
        reason: "no speech credentials",
      }),
    ).toBe("unknown");
  });
});

describe("the operator's columns", () => {
  it("accepts the strict default policy and says it is the default", () => {
    expect(stateOf("consent_policy")).toBe("ok");
    expect(detailOf("consent_policy")).toContain("per_number");
  });

  it("blocks a claimed standing relationship with no basis recorded", () => {
    expect(
      stateOf("consent_policy", { consentPolicy: "existing_relationship", consentBasis: null }),
    ).toBe("blocked");
  });

  it("reports a missing consent column as a migration that has not run", () => {
    expect(stateOf("consent_policy", { consentPolicy: null })).toBe("unknown");
  });

  /** Unset is a supported and honest configuration. It is listed, not failed. */
  it("flags unset business hours without treating them as a fault", () => {
    expect(stateOf("business_hours", { businessHours: null })).toBe("attention");
  });
});

describe("escalation", () => {
  it("warns when an organisation inherits the platform's number", () => {
    expect(stateOf("escalation", { escalationConfigured: false })).toBe("attention");
  });

  it("blocks when nobody anywhere would answer a transfer", () => {
    expect(
      stateOf("escalation", { escalationConfigured: false }, { platformHandoff: false }),
    ).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// Tools, credentials and events
// ---------------------------------------------------------------------------

const HTTP_TOOL = {
  name: "check_policy",
  description: "Look a policy up",
  parameters: { type: "object", properties: {} },
  riskTier: "read",
  route: "http",
  url: "https://api.tenant.test/policy",
  method: "GET",
  send: "query",
  speech: { template: "It is {status}.", fallback: "I could not find it." },
};

const TOOLS = (overrides: Record<string, unknown> = {}): unknown => ({
  egress: { allowedHosts: ["api.tenant.test"] },
  http: [{ ...HTTP_TOOL, ...overrides }],
});

const EVENTS = (overrides: Record<string, unknown> = {}): unknown => ({
  egress: { allowedHosts: ["hooks.tenant.test"] },
  subscriptions: [
    {
      name: "crm",
      url: "https://hooks.tenant.test/ansa",
      events: ["call.ended"],
      signingSecretRef: "crm_signing",
      ...overrides,
    },
  ],
});

describe("tools", () => {
  it("treats no tools as a complete configuration", () => {
    expect(stateOf("tools")).toBe("ok");
  });

  it("registers what parses", () => {
    expect(stateOf("tools", { toolConfig: TOOLS() })).toBe("ok");
    expect(detailOf("tools", { toolConfig: TOOLS() })).toContain("check_policy");
  });

  /**
   * The whole reason readiness re-parses rather than reading a summary: a document that
   * throws here throws on every call, where it is caught, logged and turned into an agent
   * with no tools. The organisation keeps a published version full of them.
   */
  it("blocks a published document that no longer parses, as config load silently does", () => {
    expect(stateOf("tools", { toolConfig: { egress: {}, http: [{ name: "x" }] } })).toBe("blocked");
  });

  /**
   * The runbook's port trap: `URL.hostname` carries no port, so an allowlist entry with one
   * matches nothing. It was silent until the parser started comparing the two.
   */
  it("blocks an allowlist entry with a port in it, which can never match a host", () => {
    const withPort = {
      egress: { allowedHosts: ["api.tenant.test:8443"] },
      http: [HTTP_TOOL],
    };
    expect(stateOf("tools", { toolConfig: withPort })).toBe("blocked");
  });

  it("flags a published document that registers nothing", () => {
    expect(stateOf("tools", { toolConfig: { egress: { allowedHosts: [] }, http: [], mcp: [] } })).toBe(
      "attention",
    );
  });
});

describe("credentials", () => {
  it("passes when nothing names one", () => {
    expect(stateOf("credentials", { toolConfig: TOOLS() })).toBe("ok");
  });

  /**
   * The silent one. Sealing refuses without the key and publishing does not, so a
   * configuration full of tools publishes fine and every credentialed one is dropped at
   * config load with an error nobody is watching.
   */
  it("blocks when a credential is named and the deployment holds no vault key", () => {
    expect(
      stateOf(
        "credentials",
        { toolConfig: TOOLS({ credentialRef: "policy_api" }), credentialRefs: ["policy_api"] },
        { credentialKey: "absent" },
      ),
    ).toBe("blocked");
  });

  it("blocks a vault key of the wrong length, which the call process will not boot on", () => {
    expect(
      stateOf(
        "credentials",
        { toolConfig: TOOLS({ credentialRef: "policy_api" }), credentialRefs: ["policy_api"] },
        { credentialKey: "malformed" },
      ),
    ).toBe("blocked");
  });

  it("blocks and names a reference the vault does not hold", () => {
    const facts = { toolConfig: TOOLS({ credentialRef: "policy_api" }), credentialRefs: [] };
    expect(stateOf("credentials", facts)).toBe("blocked");
    expect(detailOf("credentials", facts)).toContain("policy_api");
  });

  it("counts the signing secret an event receiver needs", () => {
    expect(stateOf("credentials", { eventConfig: EVENTS(), credentialRefs: [] })).toBe("blocked");
    expect(stateOf("credentials", { eventConfig: EVENTS(), credentialRefs: ["crm_signing"] })).toBe(
      "ok",
    );
  });

  it("cannot decide which credentials are needed when a document does not parse", () => {
    expect(stateOf("credentials", { toolConfig: { egress: {}, http: [{ name: "x" }] } })).toBe(
      "unknown",
    );
  });
});

describe("event receivers", () => {
  it("treats none configured as a complete configuration", () => {
    expect(stateOf("events")).toBe("ok");
  });

  it("blocks an event document that does not parse, since nothing would be delivered", () => {
    expect(stateOf("events", { eventConfig: { subscriptions: [{ name: "crm" }] } })).toBe("blocked");
  });

  it("reports deliveries that were given up on rather than probing the receiver", () => {
    const facts = { eventConfig: EVENTS(), credentialRefs: ["crm_signing"], failedDeliveries: 3 };
    expect(stateOf("events", facts)).toBe("attention");
    expect(detailOf("events", facts)).toContain("3");
  });

  it("passes a configured receiver with a clean delivery history", () => {
    expect(stateOf("events", { eventConfig: EVENTS(), credentialRefs: ["crm_signing"] })).toBe("ok");
  });
});
