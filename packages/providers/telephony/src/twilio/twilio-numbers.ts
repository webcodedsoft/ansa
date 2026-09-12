import { Buffer } from "node:buffer";

import type {
  AvailableNumber,
  CarrierCountry,
  CarrierNumber,
  CarrierNumberStore,
  PurchasedNumber,
} from "../types";

/**
 * Twilio's numbers, read and bought over REST.
 *
 * `IncomingPhoneNumbers` and `AvailablePhoneNumbers` rather than the SDK's client, matching
 * the rest of this adapter: one REST call, one shape, and no vendor object escaping the
 * file. The account SID and auth token are the same pair `createTwilioTelephonyProvider`
 * takes, and a deployment that has no REST credentials simply does not construct this — the
 * caller reports the webhook state as unchecked rather than being handed a directory that
 * always throws.
 *
 * **Twilio sells no Nigerian numbers.** Reading a Nigerian number answers null (it lives at
 * the organisation's own carrier); buying one is not offered, because `countries()` will
 * not list NG. The store is still worth having: a Lagos business that wants a London or a
 * New York line for its diaspora customers can buy one here, and a deployment outside
 * Nigeria has the whole catalogue.
 */

export interface TwilioNumberDirectoryOptions {
  /** Account SID (AC…). Reading numbers needs REST credentials; answering calls does not. */
  readonly accountSid: string;
  readonly authToken: string;
  /** Overridden in tests. */
  readonly apiBaseUrl?: string;
  /** Twilio's pricing API lives on its own host; overridden in tests. */
  readonly pricingBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Short, and shorter than the call path's budgets on purpose. This runs behind a dashboard
 * request, and a carrier that is not answering must produce "could not check" quickly
 * rather than holding a page open until a proxy gives up on it. A purchase gets longer,
 * because abandoning one half-way is how a number gets bought and never recorded.
 */
const REQUEST_TIMEOUT_MS = 4_000;
const PURCHASE_TIMEOUT_MS = 15_000;

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

/** What the carrier said when it refused, kept short: it is shown to a person on a page. */
const refusal = async (what: string, response: Response): Promise<Error> => {
  const detail = await response.text().catch(() => "");
  let message = detail.slice(0, 200);
  try {
    const parsed: unknown = JSON.parse(detail);
    if (isRecord(parsed) && typeof parsed["message"] === "string") message = parsed["message"].slice(0, 200);
  } catch {
    // Not JSON; the raw text is the best there is.
  }
  return new Error(`Carrier refused ${what} (${response.status}): ${message}`);
};

export const createTwilioNumberDirectory = (options: TwilioNumberDirectoryOptions): CarrierNumberStore => {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = options.apiBaseUrl ?? "https://api.twilio.com";
  const pricing = options.pricingBaseUrl ?? "https://pricing.twilio.com";
  const account = `${base}/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}`;
  const authorization = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64")}`;

  const get = async (url: string, what: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> => {
    const response = await doFetch(url, {
      headers: { Authorization: authorization, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Surfaced, not swallowed. A 401 here means the dashboard's carrier credentials are
    // wrong — or the account is not active — which is worth saying out loud.
    if (!response.ok) throw await refusal(what, response);
    const body: unknown = await response.json();
    if (!isRecord(body)) throw new Error(`Carrier returned ${what} that was not an object`);
    return body;
  };

  /** Twilio's monthly price for local numbers in a country, or nulls when the pricing API says nothing. */
  const monthlyPriceFor = async (
    country: string,
  ): Promise<{ readonly price: string | null; readonly currency: string | null }> => {
    try {
      const body = await get(
        `${pricing}/v1/PhoneNumbers/Countries/${encodeURIComponent(country)}`,
        "the number pricing",
      );
      const currency = readString(body["price_unit"]);
      const prices = body["phone_number_prices"];
      if (!Array.isArray(prices)) return { price: null, currency };
      const local = (prices as unknown[]).find(
        (entry) => isRecord(entry) && entry["number_type"] === "local",
      );
      const price = isRecord(local) ? readString(local["current_price"]) : null;
      return { price, currency };
    } catch {
      /* A price is decoration on the search; the numbers are the answer. A pricing outage
         must not make the catalogue look empty. */
      return { price: null, currency: null };
    }
  };

  return {
    name: "twilio",

    describeNumber: async (number: string): Promise<CarrierNumber | null> => {
      // Filtered by the carrier rather than by paging the whole inventory here: an account
      // with several hundred numbers would otherwise cost several requests to answer one
      // question, and the exact-match filter is the API's own.
      const body = await get(
        `${account}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}&PageSize=1`,
        "the number lookup",
      );
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

    countries: async (): Promise<readonly CarrierCountry[]> => {
      const body = await get(`${account}/AvailablePhoneNumbers.json?PageSize=500`, "the country list");
      const list = body["countries"];
      if (!Array.isArray(list)) return [];
      const out: CarrierCountry[] = [];
      for (const entry of list as unknown[]) {
        if (!isRecord(entry)) continue;
        const code = readString(entry["country_code"]);
        const name = readString(entry["country"]);
        if (code !== null && name !== null) out.push({ code, name });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },

    searchAvailable: async (country, search): Promise<readonly AvailableNumber[]> => {
      const limit = Math.min(Math.max(search.limit ?? 10, 1), 30);
      const query = new URLSearchParams({ VoiceEnabled: "true", PageSize: String(limit) });
      if (search.areaCode !== undefined && search.areaCode.trim() !== "") {
        query.set("AreaCode", search.areaCode.trim());
      } else if (search.contains !== undefined && search.contains.trim() !== "") {
        query.set("Contains", search.contains.trim());
      }
      const [body, priced] = await Promise.all([
        get(
          `${account}/AvailablePhoneNumbers/${encodeURIComponent(country)}/Local.json?${query.toString()}`,
          "the number search",
        ),
        monthlyPriceFor(country),
      ]);
      const list = body["available_phone_numbers"];
      if (!Array.isArray(list)) return [];
      const out: AvailableNumber[] = [];
      for (const entry of list as unknown[]) {
        if (!isRecord(entry)) continue;
        const number = readString(entry["phone_number"]);
        if (number === null) continue;
        out.push({
          number,
          country: readString(entry["iso_country"]) ?? country,
          locality: readString(entry["locality"]) ?? readString(entry["region"]),
          monthlyPrice: priced.price,
          currency: priced.currency,
        });
      }
      return out;
    },

    buy: async (number, purchase): Promise<PurchasedNumber> => {
      const form = new URLSearchParams({
        PhoneNumber: number,
        VoiceUrl: purchase.voiceUrl,
        VoiceMethod: "POST",
        FriendlyName: purchase.label.slice(0, 64),
      });
      const response = await doFetch(`${account}/IncomingPhoneNumbers.json`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(PURCHASE_TIMEOUT_MS),
      });
      if (!response.ok) throw await refusal("the purchase", response);
      const body: unknown = await response.json();
      if (!isRecord(body)) throw new Error("Carrier returned a purchase that was not an object");
      const sid = readString(body["sid"]);
      const bought = readString(body["phone_number"]);
      // A purchase without an id is a number that cannot be released; refusing to report
      // it as bought is the only way the caller can tell.
      if (sid === null || bought === null) throw new Error("Carrier returned a purchase with no sid or number");
      return { number: bought, carrierSid: sid, voiceUrl: readString(body["voice_url"]) };
    },

    release: async (carrierSid): Promise<void> => {
      const response = await doFetch(`${account}/IncomingPhoneNumbers/${encodeURIComponent(carrierSid)}.json`, {
        method: "DELETE",
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(PURCHASE_TIMEOUT_MS),
      });
      // Already gone is gone: a number released at the carrier's console yesterday must not
      // stop the record here from being tidied up today.
      if (!response.ok && response.status !== 404) throw await refusal("the release", response);
    },
  };
};
