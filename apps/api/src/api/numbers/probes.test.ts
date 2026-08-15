import type { CarrierNumber, CarrierNumberDirectory } from "@ansa/telephony";
import type { VoiceCatalogue } from "@ansa/tts";
import { describe, expect, it } from "vitest";

import type { NumbersEnvironment } from "./environment";
import { probeCarrierWebhook, probeVoice } from "./probes";

/**
 * The two lookups that leave the process, and the rule they both obey: never throw, and
 * never let "we could not ask" become an answer about the organisation's configuration.
 */

const ENVIRONMENT: NumbersEnvironment = {
  publicBaseUrl: "https://ansa.example",
  carrier: null,
  voice: null,
  platformVoiceId: null,
  credentialKey: "present",
  platformHandoff: false,
};

const EXPECTED = "https://ansa.example/telephony/voice";

const directoryReturning = (held: CarrierNumber | null): CarrierNumberDirectory => ({
  name: "twilio",
  describeNumber: async () => held,
});

const directoryFailing = (): CarrierNumberDirectory => ({
  name: "twilio",
  describeNumber: async () => {
    throw new Error("401 Authenticate: AC0123456789 is not permitted");
  },
});

describe("the carrier webhook probe", () => {
  it("matches when the carrier points at this deployment", async () => {
    const probe = await probeCarrierWebhook(
      ENVIRONMENT,
      "+15550000001",
      directoryReturning({ number: "+15550000001", voiceUrl: EXPECTED, voiceMethod: "POST" }),
    );
    expect(probe.state).toBe("matches");
    expect(probe.expected).toBe(EXPECTED);
  });

  it("reports where the carrier actually points when it is not here", async () => {
    const probe = await probeCarrierWebhook(
      ENVIRONMENT,
      "+15550000001",
      directoryReturning({
        number: "+15550000001",
        voiceUrl: "https://old.example/voice",
        voiceMethod: "POST",
      }),
    );
    expect(probe.state).toBe("points-elsewhere");
    expect(probe.observed).toBe("https://old.example/voice");
  });

  it("separates a number held with no webhook from one the account does not hold", async () => {
    const held = await probeCarrierWebhook(
      ENVIRONMENT,
      "+15550000001",
      directoryReturning({ number: "+15550000001", voiceUrl: null, voiceMethod: null }),
    );
    expect(held.state).toBe("not-set");

    const absent = await probeCarrierWebhook(ENVIRONMENT, "+2348000000000", directoryReturning(null));
    expect(absent.state).toBe("not-in-carrier-account");
    expect(absent.reason).toContain("twilio");
  });

  it("is unchecked, with a reason, when the deployment has no carrier account", async () => {
    const probe = await probeCarrierWebhook(ENVIRONMENT, "+2348000000000", null);
    expect(probe.state).toBe("unchecked");
    expect(probe.reason).toContain("no carrier account credentials");
    expect(probe.expected).toBe(EXPECTED);
  });

  it("still states the URL to configure when there is no number yet", async () => {
    const probe = await probeCarrierWebhook(ENVIRONMENT, null, null);
    expect(probe.state).toBe("unchecked");
    expect(probe.expected).toBe(EXPECTED);
  });

  it("cannot state an expected URL when the process does not know its own address", async () => {
    const probe = await probeCarrierWebhook(
      { ...ENVIRONMENT, publicBaseUrl: null },
      "+15550000001",
      directoryReturning({ number: "+15550000001", voiceUrl: EXPECTED, voiceMethod: "POST" }),
    );
    expect(probe.state).toBe("unchecked");
    expect(probe.expected).toBeNull();
  });

  /**
   * A carrier error message can carry an account identifier. This response is read by the
   * organisation's staff, so the reason says whose problem it is and nothing else.
   */
  it("does not put the carrier's own error text in the response", async () => {
    const probe = await probeCarrierWebhook(ENVIRONMENT, "+15550000001", directoryFailing());
    expect(probe.state).toBe("unchecked");
    expect(probe.reason).toBe("the twilio account could not be read");
  });
});

/**
 * Readiness asks one question of the catalogue and it is never `list`. Rejecting rather
 * than returning an empty listing is what fails this file loudly if that ever changes,
 * instead of a probe quietly deciding a voice is unknown because a list came back empty.
 */
const neverListed = async (): Promise<never> => {
  throw new Error("the readiness probe must not list the account");
};

const catalogueReturning = (known: boolean): VoiceCatalogue => ({
  name: "elevenlabs",
  knows: async () => known,
  list: neverListed,
});

const catalogueFailing = (): VoiceCatalogue => ({
  name: "elevenlabs",
  knows: async () => {
    throw new Error("401 Unauthorized: key sk_abc123");
  },
  list: neverListed,
});

describe("the voice probe", () => {
  it("checks the organisation's own voice when it has one", async () => {
    const probe = await probeVoice(ENVIRONMENT, "their-voice", catalogueReturning(true));
    expect(probe).toMatchObject({ state: "known", voiceId: "their-voice", source: "organisation" });
  });

  /** The voice that will actually speak, which for an unconfigured organization is the platform's. */
  it("falls back to the platform's voice, and says that is what it checked", async () => {
    const probe = await probeVoice(
      { ...ENVIRONMENT, platformVoiceId: "platform-voice" },
      null,
      catalogueReturning(true),
    );
    expect(probe).toMatchObject({ state: "known", voiceId: "platform-voice", source: "platform" });
  });

  it("reports no voice at all when neither the organisation nor the deployment has one", async () => {
    const probe = await probeVoice(ENVIRONMENT, null, catalogueReturning(true));
    expect(probe.state).toBe("none-configured");
  });

  it("says the account does not resolve a voice it does not resolve", async () => {
    const probe = await probeVoice(ENVIRONMENT, "wrong", catalogueReturning(false));
    expect(probe.state).toBe("unknown-to-account");
  });

  it("is unchecked when the deployment holds no speech credentials", async () => {
    const probe = await probeVoice(ENVIRONMENT, "their-voice", null);
    expect(probe.state).toBe("unchecked");
    expect(probe.reason).toContain("no speech account credentials");
  });

  it("does not leak the vendor's error text, which can carry a key", async () => {
    const probe = await probeVoice(ENVIRONMENT, "their-voice", catalogueFailing());
    expect(probe.state).toBe("unchecked");
    expect(probe.reason).toBe("the elevenlabs account could not be read");
  });
});
