import { describe, expect, it } from "vitest";

import { wasAnswered } from "../types";
import { createTwilioTelephonyProvider } from "./twilio-telephony.provider";

const provider = createTwilioTelephonyProvider({ authToken: "t", verifySignatures: true });
const parse = (payload: Record<string, string>) => provider.parseCallStatus(payload);

describe("parseCallStatus", () => {
  it("reads a call that rang out", () => {
    // The whole reason this endpoint exists: no media stream is ever opened, so without
    // this the call is indistinguishable from one that was never placed.
    const event = parse({ CallSid: "CA1", CallStatus: "no-answer", Direction: "outbound-api" });
    expect(event).toMatchObject({ callId: "CA1", status: "no-answer", direction: "outbound" });
    expect(wasAnswered(event!)).toBe(false);
  });

  it("collapses the carrier's two outbound flavours into one", () => {
    // "outbound-api" versus "outbound-dial" is a vendor distinction; leaking it upward
    // would put a carrier word in orchestration code.
    for (const d of ["outbound-api", "outbound-dial"]) {
      expect(parse({ CallSid: "CA1", CallStatus: "ringing", Direction: d })?.direction).toBe("outbound");
    }
    expect(parse({ CallSid: "CA1", CallStatus: "ringing", Direction: "inbound" })?.direction).toBe("inbound");
  });

  it("tells a completed call that connected from one that did not", () => {
    const talked = parse({ CallSid: "CA1", CallStatus: "completed", CallDuration: "42", Direction: "outbound-api" });
    const rangOut = parse({ CallSid: "CA2", CallStatus: "completed", CallDuration: "0", Direction: "outbound-api" });

    // Both "end". Only one is worth retrying.
    expect(wasAnswered(talked!)).toBe(true);
    expect(wasAnswered(rangOut!)).toBe(false);
  });

  it("keeps the SIP code so a failure can be explained", () => {
    expect(parse({ CallSid: "CA1", CallStatus: "busy", SipResponseCode: "486" })?.sipCode).toBe(486);
  });

  it("returns null rather than throwing on anything unrecognised", () => {
    // A carrier adding a status must not take the process down.
    expect(parse({ CallSid: "CA1", CallStatus: "teleported" })).toBeNull();
    expect(provider.parseCallStatus(null)).toBeNull();
    expect(provider.parseCallStatus({ CallStatus: "completed" })).toBeNull();
  });

  it("reports no duration while the call is still in flight", () => {
    expect(parse({ CallSid: "CA1", CallStatus: "ringing" })?.durationSeconds).toBeNull();
  });
});
