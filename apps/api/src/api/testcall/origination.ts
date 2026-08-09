import type { Db } from "@ansa/db";
import type { Logger, TenantId } from "@ansa/shared";
import { createTwilioTelephonyProvider, type PlacedCall } from "@ansa/telephony";
import { ServiceUnavailableException } from "@nestjs/common";

import { placeOutboundCall } from "../../outbound/place";
import { AMD_WEBHOOK_PATH, MEDIA_STREAM_PATH, STATUS_WEBHOOK_PATH } from "../../telephony/tokens";

/**
 * The dashboard's way to the one door that places a call.
 *
 * `apps/api/src/outbound/place.ts` is that door and it enforces the consent gate. Nothing
 * here calls `provider.placeCall`, and the reason is the reason the door exists: a second
 * origination path is how the check ends up on one route and not the other, and the route
 * without it would be the one with a button on it.
 *
 * **This file holds a database handle, which is otherwise `TenantGateway`'s alone.** It is
 * a deliberate exception with a narrow shape, so it is worth stating what keeps it safe.
 * `placeOutboundCall` opens its own tenant scope to read the consent record — it has to,
 * because it is called from the call path and from a script as well as from here — so it
 * takes a `Db`. What this file does with that handle is hand it to that function and
 * nothing else: there is no statement in this file, no `TenantScope` leaves it, and the
 * only exported operation takes the tenant from its caller. The five layers in
 * `src/api/README.md` are untouched, because nothing here queries anything.
 *
 * **The carrier is configured separately from the rest of the process.** `AppConfig` throws
 * at boot without a TTS key and a transcription key, which is right for a process whose job
 * is answering calls and wrong as a precondition for serving a dashboard — the API's own
 * integration test boots `ApiModule` with nothing but a database. So the three values a test
 * call needs are read here, and their absence is a 503 on this one endpoint rather than a
 * process that will not start.
 */

/** Everything a test call needs from the environment, and nothing the rest of the API needs. */
export interface CarrierEnvironment {
  /** The externally reachable origin. The carrier dials back into it for media and status. */
  readonly publicBaseUrl: string;
  /** `AC…`. Only outbound needs it, which is why `AppConfig` has it as optional. */
  readonly accountSid: string;
  readonly authToken: string;
}

export interface EnvironmentReading {
  /** Null when anything is missing. Never partially filled. */
  readonly environment: CarrierEnvironment | null;
  /** The variables that were not set, named so the 503 can say which. */
  readonly missing: readonly string[];
}

const value = (env: NodeJS.ProcessEnv, key: string): string | null => {
  const raw = env[key];
  return raw === undefined || raw.trim() === "" ? null : raw.trim();
};

export const readCarrierEnvironment = (env: NodeJS.ProcessEnv): EnvironmentReading => {
  // Trailing slash removed for the same reason `config/env.ts` removes it: it would produce
  // a double slash in a URL the carrier signs, and every webhook would fail validation.
  const publicBaseUrl = value(env, "PUBLIC_BASE_URL")?.replace(/\/+$/, "") ?? null;
  const accountSid = value(env, "TWILIO_ACCOUNT_SID");
  const authToken = value(env, "TWILIO_AUTH_TOKEN");

  const missing = [
    ...(publicBaseUrl === null ? ["PUBLIC_BASE_URL"] : []),
    ...(accountSid === null ? ["TWILIO_ACCOUNT_SID"] : []),
    ...(authToken === null ? ["TWILIO_AUTH_TOKEN"] : []),
  ];

  if (publicBaseUrl === null || accountSid === null || authToken === null) {
    return { environment: null, missing };
  }
  return { environment: { publicBaseUrl, accountSid, authToken }, missing };
};

/**
 * Where the carrier calls back to, derived from one origin.
 *
 * The three paths are imported from `telephony/tokens.ts` rather than written out. A test
 * call that pointed at a path the process does not serve would ring, be answered by
 * silence, and look like a media bug.
 */
export const callbackUrls = (
  publicBaseUrl: string,
): { mediaStreamUrl: string; statusCallbackUrl: string; amdCallbackUrl: string } => ({
  mediaStreamUrl: `${publicBaseUrl.replace(/^http/, "ws")}${MEDIA_STREAM_PATH}`,
  statusCallbackUrl: `${publicBaseUrl}${STATUS_WEBHOOK_PATH}`,
  amdCallbackUrl: `${publicBaseUrl}${AMD_WEBHOOK_PATH}`,
});

export interface TestCallRequest {
  /**
   * Whose call it is. Named `owner` rather than passed positionally for the reason
   * `refusals.ts` gives — `routes.test.ts` is blunt about a tenant id in an argument list,
   * and rightly, because that is the shape of the mistake this whole layer removes.
   */
  readonly owner: TenantId;
  /** E.164, and it must have consent on record. `place.ts` decides that, not this. */
  readonly to: string;
  /** E.164, and it must be a number the carrier account owns. */
  readonly from: string;
}

export interface Origination {
  place(request: TestCallRequest): Promise<PlacedCall>;
}

/** The token `ApiModule` provides this under. A symbol, like the telephony module's. */
export const ORIGINATION = Symbol("ORIGINATION");

export const createOrigination = (deps: {
  readonly dataSource: Db | null;
  readonly log: Logger;
  readonly env?: NodeJS.ProcessEnv;
}): Origination => {
  const reading = readCarrierEnvironment(deps.env ?? process.env);
  const environment = reading.environment;

  // Built once and kept, so a run of test calls reuses the connection. Null when the
  // deployment cannot place calls at all, which is a working inbound-only configuration.
  const telephony =
    environment === null
      ? null
      : createTwilioTelephonyProvider({
          authToken: environment.authToken,
          // Signature verification is about webhooks arriving, not about calls leaving; the
          // value that matters here is the account the call is billed to.
          verifySignatures: true,
          accountSid: environment.accountSid,
        });

  return {
    async place(request) {
      if (environment === null || telephony === null) {
        throw new ServiceUnavailableException(
          `this deployment cannot place calls: ${reading.missing.join(", ")} not set`,
        );
      }
      if (deps.dataSource === null) {
        // `placeOutboundCall` would refuse this as a consent failure, which is true and
        // misleading: nothing is wrong with the organisation's consent record, the process
        // cannot read it. Saying so as a 503 keeps "we may not call this number" meaning
        // exactly that.
        throw new ServiceUnavailableException("the dashboard is not available without a database");
      }

      return placeOutboundCall(
        { dataSource: deps.dataSource, telephony, log: deps.log },
        {
          tenantId: request.owner,
          to: request.to,
          from: request.from,
          ...callbackUrls(environment.publicBaseUrl),
        },
      );
    },
  };
};
