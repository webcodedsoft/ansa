import { describe, expect, it } from "vitest";

import { createTwilioNumberDirectory } from "./twilio-numbers";

/**
 * The three answers that matter are "it points here", "it points somewhere else" and "the
 * account does not hold it" — and the last of those is the ordinary answer for a Nigerian
 * number, so it has to be a value and not an exception.
 */

const respond = (status: number, body: unknown): typeof globalThis.fetch =>
  ((async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response) as unknown as typeof globalThis.fetch);

const directory = (fetchImpl: typeof globalThis.fetch): ReturnType<typeof createTwilioNumberDirectory> =>
  createTwilioNumberDirectory({
    accountSid: "AC00000000000000000000000000000000",
    authToken: "test-token",
    apiBaseUrl: "https://carrier.test",
    fetch: fetchImpl,
  });

describe("the carrier number directory", () => {
  it("reports where the carrier currently sends calls to a number it holds", async () => {
    const found = await directory(
      respond(200, {
        incoming_phone_numbers: [
          { phone_number: "+15550000001", voice_url: "https://ansa.test/telephony/voice", voice_method: "POST" },
        ],
      }),
    ).describeNumber("+15550000001");

    expect(found).toEqual({
      number: "+15550000001",
      voiceUrl: "https://ansa.test/telephony/voice",
      voiceMethod: "POST",
    });
  });

  /**
   * The Nigerian case, and the reason this returns null rather than throwing: the number
   * exists, it is simply not in an account we can read. Treating it as an error would make
   * every tenant this product is for look broken.
   */
  it("answers null when the account does not hold the number", async () => {
    const found = await directory(respond(200, { incoming_phone_numbers: [] })).describeNumber(
      "+2348000000000",
    );
    expect(found).toBeNull();
  });

  /** A number in the account with no voice URL set is held, and misrouted. Not the same as absent. */
  it("distinguishes a number with no webhook from a number that is not there", async () => {
    const found = await directory(
      respond(200, { incoming_phone_numbers: [{ phone_number: "+15550000002" }] }),
    ).describeNumber("+15550000002");
    expect(found).toEqual({ number: "+15550000002", voiceUrl: null, voiceMethod: null });
  });

  /** A carrier filter that answered with a different number is not an answer to this question. */
  it("ignores an entry that is not the number that was asked about", async () => {
    const found = await directory(
      respond(200, { incoming_phone_numbers: [{ phone_number: "+15550000003" }] }),
    ).describeNumber("+15550000004");
    expect(found).toBeNull();
  });

  /**
   * Rejected rather than reported as "not held". Wrong credentials and an unassigned
   * number would otherwise produce the same readiness answer, and only one of them is
   * the tenant's problem.
   */
  it("rejects when the carrier refuses the credential", async () => {
    await expect(
      directory(respond(401, { message: "Authenticate" })).describeNumber("+15550000005"),
    ).rejects.toThrow(/401/);
  });

  it("rejects when the carrier answers with something that is not a number list", async () => {
    await expect(
      directory(respond(200, { message: "ok" })).describeNumber("+15550000006"),
    ).rejects.toThrow(/incoming_phone_numbers/);
  });
});

/** Buying and releasing: one call each, and the answer the caller can act on. */
const answering = (
  routes: Readonly<Record<string, { readonly status: number; readonly body: unknown }>>,
  seen: { method: string; url: string; body: string | null }[] = [],
): typeof globalThis.fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? init.body : null });
    const hit = Object.entries(routes).find(([prefix]) => url.includes(prefix));
    const status = hit?.[1].status ?? 404;
    const body = hit?.[1].body ?? { message: "no such route in the fake" };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;

describe("the carrier number store", () => {
  it("lists the countries the carrier sells in, by name", async () => {
    const store = directory(
      answering({
        "/AvailablePhoneNumbers.json": {
          status: 200,
          body: { countries: [{ country_code: "US", country: "United States" }, { country_code: "GB", country: "United Kingdom" }] },
        },
      }),
    );
    expect(await store.countries()).toEqual([
      { code: "GB", name: "United Kingdom" },
      { code: "US", name: "United States" },
    ]);
  });

  it("searches a country's local numbers and attaches the country's monthly price", async () => {
    const seen: { method: string; url: string; body: string | null }[] = [];
    const store = directory(
      answering(
        {
          "/AvailablePhoneNumbers/GB/Local.json": {
            status: 200,
            body: { available_phone_numbers: [{ phone_number: "+442071234567", iso_country: "GB", locality: "London" }] },
          },
          "/v1/PhoneNumbers/Countries/GB": {
            status: 200,
            body: { price_unit: "USD", phone_number_prices: [{ number_type: "local", current_price: "1.15" }] },
          },
        },
        seen,
      ),
    );
    const found = await store.searchAvailable("GB", { contains: "207", limit: 5 });
    expect(found).toEqual([
      { number: "+442071234567", country: "GB", locality: "London", monthlyPrice: "1.15", currency: "USD" },
    ]);
    expect(seen.find((s) => s.url.includes("/Local.json"))?.url).toContain("Contains=207");
  });

  it("still lists numbers when the pricing API is down", async () => {
    const store = directory(
      answering({
        "/AvailablePhoneNumbers/US/Local.json": {
          status: 200,
          body: { available_phone_numbers: [{ phone_number: "+15550001111", iso_country: "US" }] },
        },
        "/v1/PhoneNumbers/Countries/US": { status: 503, body: { message: "down" } },
      }),
    );
    expect(await store.searchAvailable("US", {})).toEqual([
      { number: "+15550001111", country: "US", locality: null, monthlyPrice: null, currency: null },
    ]);
  });

  it("buys a number pointed at the voice webhook and returns the carrier's id", async () => {
    const seen: { method: string; url: string; body: string | null }[] = [];
    const store = directory(
      answering(
        {
          "/IncomingPhoneNumbers.json": {
            status: 201,
            body: { sid: "PN123", phone_number: "+15550001111", voice_url: "https://ansa.test/telephony/voice" },
          },
        },
        seen,
      ),
    );
    const bought = await store.buy("+15550001111", { voiceUrl: "https://ansa.test/telephony/voice", label: "Oakhaven" });
    expect(bought).toEqual({ number: "+15550001111", carrierSid: "PN123", voiceUrl: "https://ansa.test/telephony/voice" });
    const post = seen.find((s) => s.method === "POST");
    expect(post?.body).toContain("VoiceUrl=https%3A%2F%2Fansa.test%2Ftelephony%2Fvoice");
    expect(post?.body).toContain("VoiceMethod=POST");
  });

  it("says why a purchase was refused, in the carrier's words", async () => {
    const store = directory(
      answering({ "/IncomingPhoneNumbers.json": { status: 400, body: { message: "The number is no longer available" } } }),
    );
    await expect(store.buy("+15550001111", { voiceUrl: "https://ansa.test/telephony/voice", label: "x" })).rejects.toThrow(
      /refused the purchase \(400\): The number is no longer available/,
    );
  });

  it("treats a number already gone at the carrier as released", async () => {
    const store = directory(answering({ "/IncomingPhoneNumbers/PN123.json": { status: 404, body: { message: "gone" } } }));
    await expect(store.release("PN123")).resolves.toBeUndefined();
  });
});
