import { Buffer } from "node:buffer";

import type { CarrierNumber, CarrierNumberDirectory } from "../types";

/**
 * Asking Twilio where one of its numbers currently sends calls.
 *
 * `IncomingPhoneNumbers` rather than the SDK's client, matching the rest of this adapter:
 * one REST call, one shape, and no vendor object escaping the file. The account SID and
 * auth token are the same pair `createTwilioTelephonyProvider` takes, and a deployment
 * that has no REST credentials simply does not construct this — the caller reports the
 * webhook state as unchecked rather than being handed a directory that always throws.
 *
 * **This can only see numbers in the platform's own Twilio account.** Twilio sells no
 * Nigerian numbers, so for the tenants this product exists for the honest answer is null:
 * their number lives at their own carrier and its webhook is not readable from here. That
 * is a gap in what can be proven, not a failure, and it is reported as such.
 */

export interface TwilioNumberDirectoryOptions {
  /** Account SID (AC…). Reading numbers needs REST credentials; answering calls does not. */
  readonly accountSid: string;
  readonly authToken: string;
  /** Overridden in tests. */
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Short, and shorter than the call path's budgets on purpose. This runs behind a dashboard
 * request, and a carrier that is not answering must produce "could not check" quickly
 * rather than holding a page open until a proxy gives up on it.
 */
const REQUEST_TIMEOUT_MS = 4_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * One entry of the carrier's list, or null when it is not shaped like one.
 *
 * A row without a phone number on it is not a number, and inventing one would put a
 * fabricated value in front of somebody deciding whether their line is wired.
 */
const toCarrierNumber = (value: unknown): CarrierNumber | null => {
  if (!isRecord(value)) return null;
  const number = readString(value["phone_number"]);
  if (number === null) return null;
  return {
    number,
    voiceUrl: readString(value["voice_url"]),
    voiceMethod: readString(value["voice_method"]),
  };
};

export const createTwilioNumberDirectory = (
  options: TwilioNumberDirectoryOptions,
): CarrierNumberDirectory => ({
  name: "twilio",

  describeNumber: async (number: string): Promise<CarrierNumber | null> => {
    const doFetch = options.fetch ?? globalThis.fetch;
    const base = options.apiBaseUrl ?? "https://api.twilio.com";
    // Filtered by the carrier rather than by paging the whole inventory here: an account
    // with several hundred numbers would otherwise cost several requests to answer one
    // question, and the exact-match filter is the API's own.
    const url =
      `${base}/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/IncomingPhoneNumbers.json` +
      `?PhoneNumber=${encodeURIComponent(number)}&PageSize=1`;

    const response = await doFetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64")}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // Surfaced, not swallowed. A 401 here means the dashboard's carrier credentials are
      // wrong, which is worth saying out loud — reporting it as "the number is not in the
      // account" would turn a fixable configuration error into a false accusation.
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Carrier refused the number lookup (${response.status}): ${detail.slice(0, 200)}`,
      );
    }

    const body: unknown = await response.json();
    if (!isRecord(body)) throw new Error("Carrier returned a number lookup that was not an object");
    const list = body["incoming_phone_numbers"];
    if (!Array.isArray(list)) {
      throw new Error("Carrier returned a number lookup with no incoming_phone_numbers list");
    }

    // An empty list is the answer for every number the account does not hold, which
    // includes every Nigerian number. Null, not an error.
    for (const entry of list as unknown[]) {
      const found = toCarrierNumber(entry);
      if (found !== null && found.number === number) return found;
    }
    return null;
  },
});
