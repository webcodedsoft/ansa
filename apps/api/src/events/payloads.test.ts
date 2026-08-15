import { describe, expect, it } from "vitest";

import { serialisePayload } from "./payloads";

/**
 * What leaves the call, now that nothing masks a caller's value.
 *
 * R5.2.4 — per-organisation masking of names, identifiers and digit runs — was withdrawn on
 * 2026-08-15. The organisation is the data controller, the caller is their customer, and the
 * payload is a record of a conversation their own agent had. These tests exist to make the
 * boundary explicit in both directions, because the two halves used to live in one function
 * and only one of them was ever meant to be unconditional.
 */
describe("serialisePayload", () => {
  const payload = (over: Record<string, unknown> = {}): never =>
    ({
      callId: "CA-1",
      transcript: [{ role: "caller", text: "My NIN is 12345678901 and my policy is PM8592625." }],
      identifiers: { nin: "12345678901", policyNumber: "PM8592625" },
      ...over,
    }) as never;

  it("sends a caller's identifiers complete", () => {
    const body = serialisePayload(payload());
    // The CRM on the other end needs the policy number to find the record. A masked one is
    // not a safer payload, it is a broken integration.
    expect(body).toContain("PM8592625");
    expect(body).toContain("12345678901");
  });

  it("leaves the transcript exactly as it was spoken", () => {
    // Free text was the hard case for the old matcher and is now not a case at all.
    expect(serialisePayload(payload())).toContain(
      "My NIN is 12345678901 and my policy is PM8592625.",
    );
  });

  it("still strips credential-shaped keys, which no configuration ever reached", () => {
    /* The one rule that survives, and the reason it survives is that it is not about the
       caller at all. An authorization header or a vault reference is material held in
       trust, not the organisation's data to receive (R5.2.1). Withdrawing R5.2.4 must not
       be read as withdrawing this. */
    const body = serialisePayload(
      payload({ authorization: "Bearer abc123", apiKey: "sk-live-xyz" }),
    );
    expect(body).not.toContain("Bearer abc123");
    expect(body).not.toContain("sk-live-xyz");
    expect(body).toContain("[redacted]");
  });

  it("does not truncate a long transcript", () => {
    // Unlike a log line: this is a record of a conversation, and one cut off mid-sentence
    // is a broken payload rather than a tidy one.
    const long = "a".repeat(5000);
    expect(serialisePayload(payload({ transcript: [{ role: "caller", text: long }] }))).toContain(
      long,
    );
  });
});
