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
