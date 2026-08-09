import { createTwilioNumberDirectory, type CarrierNumberDirectory } from "@ansa/telephony";
import { createElevenLabsVoiceCatalogue, type VoiceCatalogue } from "@ansa/tts";

import { expectedVoiceWebhookUrl, type NumbersEnvironment } from "./environment";

/**
 * The two readiness questions that cannot be answered from the database.
 *
 * Both reach a vendor, both are read-only, and neither may ever throw: a readiness endpoint
 * that 500s because a carrier is slow has failed at the one thing it exists to do. Every
 * failure becomes a state with a reason on it, and the reason says whose problem it is.
 *
 * The reasons are deliberately not the vendor's error text. A carrier message can carry an
 * account SID and a vendor message can carry a key prefix, and neither belongs in a
 * response an organisation's staff can read.
 */

export type WebhookState =
  /** The carrier holds the number and sends its calls here. */
  | "matches"
  /** The carrier holds the number and sends its calls to a different URL. */
  | "points-elsewhere"
  /** The carrier holds the number and no voice URL is set on it at all. */
  | "not-set"
  /** The carrier account does not hold this number, so its routing is invisible from here. */
  | "not-in-carrier-account"
  /** Nobody asked. The reason says why. */
  | "unchecked";

export interface WebhookProbe {
  readonly state: WebhookState;
  /** The URL the carrier should be pointed at, or null if this process cannot state one. */
  readonly expected: string | null;
  /** What the carrier actually has. Null unless the account holds the number. */
  readonly observed: string | null;
  /** Present on `unchecked` and `not-in-carrier-account`; null otherwise. */
  readonly reason: string | null;
}

export type VoiceState =
  /** The speech account resolves this id, so synthesis will not fail on it. */
  | "known"
  /** The account does not resolve it. Every call to this organisation will end in silence. */
  | "unknown-to-account"
  /** No voice is configured anywhere, not even a platform fallback. */
  | "none-configured"
  | "unchecked";

export interface VoiceProbe {
  readonly state: VoiceState;
  /** Which voice was checked, and whether it is the organisation's or the platform's. */
  readonly voiceId: string | null;
  readonly source: "organisation" | "platform" | "none";
  readonly reason: string | null;
}

const unchecked = (expected: string | null, reason: string): WebhookProbe => ({
  state: "unchecked",
  expected,
  observed: null,
  reason,
});

/**
 * Where the carrier currently sends calls to this organisation's number.
 *
 * `directory` is injected so the tests do not need a carrier; production passes the one
 * built from the environment below.
 */
export const probeCarrierWebhook = async (
  environment: NumbersEnvironment,
  number: string | null,
  directory: CarrierNumberDirectory | null,
): Promise<WebhookProbe> => {
  const expected = expectedVoiceWebhookUrl(environment);
  if (number === null) return unchecked(expected, "no number is attached to this organisation");
  if (directory === null) {
    return unchecked(
      expected,
      "this deployment holds no carrier account credentials, so the carrier's own record cannot be read",
    );
  }
  if (expected === null) {
    return unchecked(null, "this process does not know its own public address");
  }

  let held;
  try {
    held = await directory.describeNumber(number);
  } catch {
    // Not the vendor's message: it can carry an account identifier, and a readiness
    // response is read by the organisation's staff rather than by an operator.
    return unchecked(expected, `the ${directory.name} account could not be read`);
  }

  if (held === null) {
    return {
      state: "not-in-carrier-account",
      expected,
      observed: null,
      reason: `this number is not in the ${directory.name} account, so its routing cannot be read from here`,
    };
  }
  if (held.voiceUrl === null) {
    return { state: "not-set", expected, observed: null, reason: null };
  }
  return {
    state: held.voiceUrl === expected ? "matches" : "points-elsewhere",
    expected,
    observed: held.voiceUrl,
    reason: null,
  };
};

/**
 * Whether the voice that will actually speak on the next call resolves.
 *
 * The organisation's own id if they set one, and the platform's fallback if they did not —
 * the same choice `apps/api/src/tenancy/call-settings.ts` makes, because checking a
 * different voice from the one that will speak is worse than not checking.
 */
export const probeVoice = async (
  environment: NumbersEnvironment,
  tenantVoiceId: string | null,
  catalogue: VoiceCatalogue | null,
): Promise<VoiceProbe> => {
  const voiceId = tenantVoiceId ?? environment.platformVoiceId;
  const source = tenantVoiceId !== null ? "organisation" : "platform";

  if (voiceId === null) {
    return {
      state: "none-configured",
      voiceId: null,
      source: "none",
      reason: "no voice is configured for this organisation and this deployment has no fallback",
    };
  }
  if (catalogue === null) {
    return {
      state: "unchecked",
      voiceId,
      source,
      reason: "this deployment holds no speech account credentials, so the voice cannot be resolved",
    };
  }

  try {
    const known = await catalogue.knows(voiceId);
    return { state: known ? "known" : "unknown-to-account", voiceId, source, reason: null };
  } catch {
    return {
      state: "unchecked",
      voiceId,
      source,
      reason: `the ${catalogue.name} account could not be read`,
    };
  }
};

/**
 * The vendor clients this deployment can actually build, or null for the ones it cannot.
 *
 * Built per request rather than wired as providers, because both are a closure over three
 * environment strings and neither holds a connection. It also keeps `api.module.ts` — the
 * one file every agent on this surface edits — out of the change.
 */
export const carrierDirectoryFor = (
  environment: NumbersEnvironment,
): CarrierNumberDirectory | null =>
  environment.carrier === null
    ? null
    : createTwilioNumberDirectory({
        accountSid: environment.carrier.accountSid,
        authToken: environment.carrier.authToken,
      });

export const voiceCatalogueFor = (environment: NumbersEnvironment): VoiceCatalogue | null => {
  const voice = environment.voice;
  if (voice === null) return null;
  return createElevenLabsVoiceCatalogue({
    apiKey: voice.apiKey,
    ...(voice.baseUrl === undefined ? {} : { baseUrl: voice.baseUrl }),
  });
};
