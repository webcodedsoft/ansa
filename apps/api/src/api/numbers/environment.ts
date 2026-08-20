import { Buffer } from "node:buffer";

/**
 * The bits of the process environment that readiness can see, and nothing else.
 *
 * Deliberately its own loader rather than a widening of `api/config.ts` or a use of
 * `config/env.ts`. `config/env.ts` throws at boot without a TTS key, a carrier token and a
 * transcription key — correct for a process whose job is answering calls, and wrong as a
 * precondition for answering "is this organisation live". `api/config.ts` is the dashboard's
 * database configuration and is shared by every endpoint.
 *
 * **Every field here is optional and nothing here throws.** A missing value never fails a
 * readiness request; it turns one check into `unknown` with the reason attached, which is
 * the honest answer and is more useful than a 500. The one thing that would be dishonest is
 * reporting a check as passing because the thing that would have failed it was unreadable.
 */

export interface CarrierCredentials {
  readonly accountSid: string;
  readonly authToken: string;
}

export interface VoiceCredentials {
  readonly apiKey: string;
  readonly baseUrl: string | undefined;
}

export interface NumbersEnvironment {
  /**
   * The externally reachable origin, with no trailing slash. Null when this process does
   * not know its own public address, in which case the expected webhook URL cannot be
   * stated and the carrier check has nothing to compare against.
   */
  readonly publicBaseUrl: string | null;
  /** REST credentials for the carrier. Null disables the webhook check, never fails it. */
  readonly carrier: CarrierCredentials | null;
  /** Credentials for the speech vendor. Null disables the voice check, never fails it. */
  readonly voice: VoiceCredentials | null;
  /**
   * Which vendor actually speaks on a call — `TTS_PROVIDER`, mirrored from `config/env.ts`.
   *
   * Here because the voice check has to know. `voice` above is an ElevenLabs account, and
   * an ElevenLabs account can say nothing useful about a Cartesia voice id: both are uuids,
   * so the check would confidently pass an id the call is about to be refused for. Saying
   * "unchecked" is the honest answer, and `probeVoice` already has that state.
   */
  readonly speaker: string;
  /** The voice a organization who has configured none falls back to. Null means there is none. */
  readonly platformVoiceId: string | null;
  /**
   * Whether the vault key is present *and* the right length.
   *
   * Both matter and they fail differently. Absent, every tool and every event subscription
   * that names a credential is dropped at config load with a log line nobody is watching —
   * the failure `docs/ONBOARDING_RUNBOOK.md` records the second organization shipping with. The
   * wrong length is worse: the call process refuses to boot, so a dashboard reporting this
   * as fine would be describing a deployment that is not running.
   */
  readonly credentialKey: "present" | "malformed" | "absent";
  /**
   * Whether the deployment has a person to transfer to when no organisation names one.
   *
   * Both numbers, both E.164, mirroring `apps/api/src/handoff/destination.ts` — which
   * returns null and logs rather than throwing when either is wrong, so a deployment can
   * be running with escalation quietly disabled. An organisation with no escalation of its
   * own inherits this, and if it is false their escalation apologises and hangs up.
   */
  readonly platformHandoff: boolean;
}

/** The same shape `handoff/destination.ts` insists on before it will dial anything. */
const E164 = /^\+[1-9]\d{6,14}$/;

const trimmed = (env: NodeJS.ProcessEnv, key: string): string | null => {
  const value = env[key];
  if (value === undefined) return null;
  const text = value.trim();
  return text === "" ? null : text;
};

/** 32 bytes, base64 — the same rule `config/env.ts` enforces at boot, reported not thrown. */
const credentialKeyState = (env: NodeJS.ProcessEnv): NumbersEnvironment["credentialKey"] => {
  const raw = trimmed(env, "TOOL_CREDENTIAL_KEY");
  if (raw === null) return "absent";
  return Buffer.from(raw, "base64").length === 32 ? "present" : "malformed";
};

const carrierFrom = (env: NodeJS.ProcessEnv): CarrierCredentials | null => {
  const accountSid = trimmed(env, "TWILIO_ACCOUNT_SID");
  const authToken = trimmed(env, "TWILIO_AUTH_TOKEN");
  // Both or neither. Half a credential produces a 401 from the carrier, which would be
  // reported as "could not check" — true, but it hides that nobody configured this.
  if (accountSid === null || authToken === null) return null;
  return { accountSid, authToken };
};

const voiceFrom = (env: NodeJS.ProcessEnv): VoiceCredentials | null => {
  const apiKey = trimmed(env, "ELEVENLABS_API_KEY");
  if (apiKey === null) return null;
  return { apiKey, baseUrl: trimmed(env, "ELEVENLABS_BASE_URL") ?? undefined };
};

export const loadNumbersEnvironment = (
  env: NodeJS.ProcessEnv = process.env,
): NumbersEnvironment => ({
  // A trailing slash would produce a double slash in the URL the carrier is told to call,
  // and the signature check compares the URL exactly. Stripped here for the same reason
  // `config/env.ts` strips it.
  publicBaseUrl: trimmed(env, "PUBLIC_BASE_URL")?.replace(/\/+$/, "") ?? null,
  carrier: carrierFrom(env),
  voice: voiceFrom(env),
  /* Unvalidated here on purpose — `config/env.ts` refuses to boot on an unknown value, and
     this surface answers dashboard requests rather than deciding what runs. */
  speaker: trimmed(env, "TTS_PROVIDER") ?? "elevenlabs",
  platformVoiceId: trimmed(env, "ELEVENLABS_VOICE_ID"),
  credentialKey: credentialKeyState(env),
  platformHandoff: [trimmed(env, "HANDOFF_TO_NUMBER"), trimmed(env, "HANDOFF_FROM_NUMBER")].every(
    (value) => value !== null && E164.test(value),
  ),
});

/**
 * The route the carrier must be pointed at, mirrored from
 * `apps/api/src/telephony/voice.controller.ts`.
 *
 * Written out rather than imported: pulling that controller in would drag the whole call
 * path — carrier SDK, listen providers, media gateway — into a dashboard request for the
 * sake of one string. `webhook.test.ts` reads the controller's source and fails if the two
 * ever disagree, which is the same trade `routes.test.ts` makes elsewhere in this layer.
 */
export const VOICE_WEBHOOK_PATH = "/telephony/voice";

/** Null when this process does not know its own public address; see `publicBaseUrl`. */
export const expectedVoiceWebhookUrl = (environment: NumbersEnvironment): string | null =>
  environment.publicBaseUrl === null ? null : `${environment.publicBaseUrl}${VOICE_WEBHOOK_PATH}`;
