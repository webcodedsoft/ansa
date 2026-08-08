import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import { asCallId } from "@ansa/shared";

import { createTwilioTelephonyProvider } from "./twilio-telephony.provider";

const ACCOUNT = "AC00000000000000000000000000000001";

const provider = (response: Partial<Response> & { json?: () => Promise<unknown> }) => {
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

const ok = () => ({
  ok: true,
  status: 201,
  json: async () => ({ sid: "CA999", status: "queued" }),
});

const formOf = (fetch: ReturnType<typeof vi.fn>): URLSearchParams =>
  new URLSearchParams((fetch.mock.calls[0]?.[1] as unknown as { body: string }).body);

describe("placeCall", () => {
  it("posts to the account's Calls resource with basic auth", async () => {
    const p = provider(ok());
    await p.provider.placeCall({ to: "+2348138178550", from: "+18148592625", mediaStreamUrl: "wss://x/media" });

    const [url, init] = p.fetch.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe(`https://carrier.test/2010-04-01/Accounts/${ACCOUNT}/Calls.json`);
    // Account SID is the username, which is what the REST API expects.
    const expected = Buffer.from(`${ACCOUNT}:secret-token`).toString("base64");
    expect(init.headers["Authorization"]).toBe(`Basic ${expected}`);
  });

  it("inlines the TwiML rather than pointing the carrier at a webhook", async () => {
    const p = provider(ok());
    await p.provider.placeCall({
      to: "+2348138178550",
      from: "+18148592625",
      mediaStreamUrl: "wss://x/media",
      parameters: { tenantId: "abc-123" },
    });

    const twiml = formOf(p.fetch).get("Twiml") ?? "";
    // No round trip on answer, and no tenant identifier sitting in a guessable URL.
    expect(twiml).toContain("<Connect>");
    expect(twiml).toContain("wss://x/media");
    expect(twiml).toContain('name="tenantId"');
    expect(formOf(p.fetch).get("Url")).toBeNull();
  });

  it("asks for voicemail detection unless told not to", async () => {
    const on = provider(ok());
    await on.provider.placeCall({ to: "+1", from: "+2", mediaStreamUrl: "wss://x" });
    // An agent talking to a voicemail greeting is useless and billed.
    expect(formOf(on.fetch).get("MachineDetection")).toBe("DetectMessageEnd");

    const off = provider(ok());
    await off.provider.placeCall({ to: "+1", from: "+2", mediaStreamUrl: "wss://x", detectVoicemail: false });
    expect(formOf(off.fetch).get("MachineDetection")).toBeNull();
  });

  it("subscribes to ringing and completion when given a callback", async () => {
    const p = provider(ok());
    await p.provider.placeCall({
      to: "+1", from: "+2", mediaStreamUrl: "wss://x",
      statusCallbackUrl: "https://x/status",
    });

    // Ringing and no-answer are what distinguish outbound; the default event set omits them.
    expect(formOf(p.fetch).getAll("StatusCallbackEvent")).toContain("ringing");
  });

  it("reports the carrier's status rather than claiming the call connected", async () => {
    const p = provider(ok());
    const placed = await p.provider.placeCall({ to: "+1", from: "+2", mediaStreamUrl: "wss://x" });

    // Queued is not answered. Starting the orchestrator off this would talk to nobody.
    expect(placed.status).toBe("queued");
    expect(placed.callId).toBe("CA999");
  });

  it("rejects when the carrier refuses, with the reason attached", async () => {
    const p = provider({
      ok: false,
      status: 400,
      text: async () => '{"message":"From is not a Twilio number"}',
    } as unknown as Response);

    // An unowned "from" is a config error, far cheaper to read here than to infer from a
    // call that never rings.
    await expect(
      p.provider.placeCall({ to: "+1", from: "+2", mediaStreamUrl: "wss://x" }),
    ).rejects.toThrow(/not a Twilio number/);
  });

  it("refuses to place a call with no account SID configured", async () => {
    const inboundOnly = createTwilioTelephonyProvider({ authToken: "t", verifySignatures: true });
    await expect(
      inboundOnly.placeCall({ to: "+1", from: "+2", mediaStreamUrl: "wss://x" }),
    ).rejects.toThrow(/account SID/);
  });
});

describe("answering-machine detection", () => {
  it("runs detection in parallel rather than in front of the call", async () => {
    const p = provider(ok());
    await p.provider.placeCall({
      to: "+1", from: "+2", mediaStreamUrl: "wss://x",
      amdCallbackUrl: "https://x/amd",
    });

    // Synchronous detection withheld the media stream for 6.9 seconds on a real call:
    // the caller says hello into nothing. Async connects immediately.
    const form = formOf(p.fetch);
    expect(form.get("AsyncAmd")).toBe("true");
    expect(form.get("AsyncAmdStatusCallback")).toBe("https://x/amd");
    expect(form.get("MachineDetection")).toBe("DetectMessageEnd");
  });

  it("asks for no detection at all when told not to", async () => {
    const p = provider(ok());
    await p.provider.placeCall({
      to: "+1", from: "+2", mediaStreamUrl: "wss://x", detectVoicemail: false,
    });
    expect(formOf(p.fetch).get("AsyncAmd")).toBeNull();
  });
});

describe("endCall", () => {
  it("completes the call through the carrier", async () => {
    const p = provider({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    await p.provider.endCall(asCallId("CA999"));

    const [url] = p.fetch.mock.calls[0] as unknown as [string];
    expect(url).toBe(`https://carrier.test/2010-04-01/Accounts/${ACCOUNT}/Calls/CA999.json`);
    expect(formOf(p.fetch).get("Status")).toBe("completed");
  });

  it("surfaces a refusal rather than pretending the call ended", async () => {
    const p = provider({
      ok: false, status: 404, text: async () => "not found",
    } as unknown as Response);
    await expect(p.provider.endCall(asCallId("CA999"))).rejects.toThrow(/404/);
  });
});
