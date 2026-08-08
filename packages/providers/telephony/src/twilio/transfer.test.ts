import { describe, expect, it, vi } from "vitest";

import { asCallId } from "@ansa/shared";

import { createTwilioTelephonyProvider } from "./twilio-telephony.provider";

const ACCOUNT = "AC00000000000000000000000000000002";

const provider = (response: Partial<Response>) => {
  const fetch = vi.fn(async () => response as Response);
  return {
    fetch,
    provider: createTwilioTelephonyProvider({
      authToken: "secret-token",
      verifySignatures: true,
      accountSid: ACCOUNT,
      apiBaseUrl: "https://carrier.test",
      fetch: fetch as unknown as typeof globalThis.fetch,
    }),
  };
};

const ok = () => ({ ok: true, status: 200, text: async () => "" }) as unknown as Response;

const twimlOf = (fetch: ReturnType<typeof vi.fn>): string =>
  new URLSearchParams(
    (fetch.mock.calls[0]?.[1] as unknown as { body: string }).body,
  ).get("Twiml") ?? "";

describe("transferToNumber", () => {
  it("updates the live call rather than placing a new one", async () => {
    const p = provider(ok());
    await p.provider.transferToNumber({
      callId: asCallId("CA123"),
      to: "+2348138178550",
      from: "+18148592625",
    });

    const [url] = p.fetch.mock.calls[0] as unknown as [string];
    // The caller is already on this call. Dialling out separately would leave them
    // holding a line with nobody on it.
    expect(url).toBe(`https://carrier.test/2010-04-01/Accounts/${ACCOUNT}/Calls/CA123.json`);
  });

  it("dials the person with our own number as the caller ID", async () => {
    const p = provider(ok());
    await p.provider.transferToNumber({
      callId: asCallId("CA123"),
      to: "+2348138178550",
      from: "+18148592625",
    });

    const twiml = twimlOf(p.fetch);
    expect(twiml).toContain("<Dial");
    expect(twiml).toContain('callerId="+18148592625"');
    expect(twiml).toContain("+2348138178550");
  });

  it("lets the caller hear ringing instead of silence", async () => {
    const p = provider(ok());
    await p.provider.transferToNumber({
      callId: asCallId("CA123"),
      to: "+234",
      from: "+1",
    });

    // Without answerOnBridge the caller hears nothing while the human's phone rings, and
    // a gap over two seconds reads as a dropped call (R6.2).
    expect(twimlOf(p.fetch)).toContain('answerOnBridge="true"');
  });

  it("plays the summary to the person answering, not to the caller", async () => {
    const p = provider(ok());
    await p.provider.transferToNumber({
      callId: asCallId("CA123"),
      to: "+234",
      from: "+1",
      whisperUrl: "https://ansa.test/handoff/whisper/abc",
    });

    // The url hangs off <Number>, which the carrier fetches when the PERSON answers and
    // plays to them alone. On <Dial> it would play to both.
    expect(twimlOf(p.fetch)).toContain(
      '<Number url="https://ansa.test/handoff/whisper/abc">+234</Number>',
    );
  });

  it("says something when nobody answers rather than hanging up on the caller", async () => {
    const p = provider(ok());
    await p.provider.transferToNumber({
      callId: asCallId("CA123"),
      to: "+234",
      from: "+1",
      ringSeconds: 25,
      noAnswerLine: "Nobody is free right now. Please call back shortly.",
    });

    const twiml = twimlOf(p.fetch);
    expect(twiml).toContain('timeout="25"');
    // A document that ends at </Dial> hangs up on a caller who has already been failed
    // once. The verb after it is the whole point.
    expect(twiml.indexOf("Nobody is free")).toBeGreaterThan(twiml.indexOf("</Dial>"));
  });

  it("escapes a destination rather than letting it close the tag", async () => {
    const p = provider(ok());
    await p.provider.transferToNumber({
      callId: asCallId("CA123"),
      to: '+234"><Hangup/>',
      from: "+1",
    });
    expect(twimlOf(p.fetch)).not.toContain("<Hangup/>");
  });

  it("rejects on a carrier refusal so the agent can still apologise out loud", async () => {
    const p = provider({
      ok: false,
      status: 400,
      text: async () => '{"message":"callerId is not a Twilio number"}',
    } as unknown as Response);

    // Swallowing this would report a transfer that never happened, and the caller is
    // still on our media stream at that moment — able to be told the truth.
    await expect(
      p.provider.transferToNumber({ callId: asCallId("CA123"), to: "+234", from: "+1" }),
    ).rejects.toThrow(/callerId is not a Twilio number/);
  });

  it("refuses to transfer with no account SID configured", async () => {
    const noRest = createTwilioTelephonyProvider({ authToken: "t", verifySignatures: true });
    await expect(
      noRest.transferToNumber({ callId: asCallId("CA1"), to: "+234", from: "+1" }),
    ).rejects.toThrow(/account SID/);
  });
});

describe("renderWhisper", () => {
  it("speaks one line and then joins the legs", () => {
    const p = provider(ok());
    const response = p.provider.renderWhisper("Transfer from Ansa. The caller is Kim Woo.");

    expect(response.contentType).toContain("text/xml");
    expect(response.body).toContain("<Say>Transfer from Ansa. The caller is Kim Woo.</Say>");
    // No <Gather>, no next verb: the summary is a preamble, not a menu the caller waits
    // behind.
    expect(response.body).not.toContain("<Gather");
  });

  it("escapes a summary containing markup", () => {
    const p = provider(ok());
    const response = p.provider.renderWhisper('Caller said "<Hangup/>"');
    expect(response.body).not.toContain("<Hangup/>");
    expect(response.body).toContain("&lt;Hangup/&gt;");
  });
});
