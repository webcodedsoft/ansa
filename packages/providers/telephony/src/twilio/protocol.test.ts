import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  renderVoicemail,
  encodeClear,
  encodeMark,
  encodeMedia,
  escapeXml,
  parseFrame,
  renderConnectStream,
  toAudioEncoding,
} from "./protocol";

const START = JSON.stringify({
  event: "start",
  sequenceNumber: "1",
  streamSid: "MZ111",
  start: {
    accountSid: "AC000",
    callSid: "CA222",
    streamSid: "MZ111",
    tracks: ["inbound"],
    mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
  },
});

const mediaFrame = (payload: Buffer, timestamp: string): string =>
  JSON.stringify({
    event: "media",
    sequenceNumber: "2",
    streamSid: "MZ111",
    media: { track: "inbound", chunk: "1", timestamp, payload: payload.toString("base64") },
  });

describe("parseFrame", () => {
  it("reads the start frame's call and stream identifiers", () => {
    expect(parseFrame(START)).toEqual({
      event: "start",
      streamSid: "MZ111",
      callSid: "CA222",
      encoding: "audio/x-mulaw",
      sampleRate: 8000,
      parameters: {},
    });
  });

  it("decodes media payloads back to the original bytes", () => {
    const audio = Buffer.from([0xff, 0x7f, 0x00, 0x80]);
    const frame = parseFrame(mediaFrame(audio, "40"));

    expect(frame?.event).toBe("media");
    if (frame?.event !== "media") throw new Error("expected a media frame");
    expect(frame.payload.equals(audio)).toBe(true);
    expect(frame.track).toBe("inbound");
  });

  it("coerces the carrier's string timestamp to a number", () => {
    const frame = parseFrame(mediaFrame(Buffer.from([0x01]), "1234"));

    if (frame?.event !== "media") throw new Error("expected a media frame");
    expect(frame.offsetMs).toBe(1234);
  });

  it("reads mark, stop, dtmf and connected frames", () => {
    expect(parseFrame(JSON.stringify({ event: "connected", protocol: "Call" }))).toEqual({
      event: "connected",
    });
    expect(
      parseFrame(JSON.stringify({ event: "mark", streamSid: "MZ111", mark: { name: "greeting" } })),
    ).toEqual({ event: "mark", streamSid: "MZ111", name: "greeting" });
    expect(parseFrame(JSON.stringify({ event: "stop", streamSid: "MZ111" }))).toEqual({
      event: "stop",
      streamSid: "MZ111",
    });
    expect(
      parseFrame(JSON.stringify({ event: "dtmf", streamSid: "MZ111", dtmf: { digit: "7" } })),
    ).toEqual({ event: "dtmf", streamSid: "MZ111", digit: "7" });
  });

  // A malformed or unfamiliar frame must not throw. Throwing inside the socket's message
  // handler would drop a live call because the carrier shipped a new event type.
  it.each([
    ["not json at all", "{{{"],
    ["json that is not an object", '"hello"'],
    ["an unknown event", JSON.stringify({ event: "somethingNew", streamSid: "MZ111" })],
    ["a missing event field", JSON.stringify({ streamSid: "MZ111" })],
    ["a start frame with no callSid", JSON.stringify({ event: "start", start: { streamSid: "MZ1" } })],
    ["a media frame with no payload", JSON.stringify({ event: "media", streamSid: "MZ1", media: {} })],
    ["a mark frame with no name", JSON.stringify({ event: "mark", streamSid: "MZ1", mark: {} })],
  ])("returns null for %s", (_label, raw) => {
    expect(parseFrame(raw)).toBeNull();
  });
});

describe("outbound frames", () => {
  it("base64-encodes audio against the stream it belongs to", () => {
    const audio = Buffer.from([0x10, 0x20, 0x30]);

    expect(JSON.parse(encodeMedia("MZ111", audio))).toEqual({
      event: "media",
      streamSid: "MZ111",
      media: { payload: audio.toString("base64") },
    });
  });

  it("round-trips audio through encode and parse unchanged", () => {
    const audio = Buffer.from(Array.from({ length: 160 }, (_, i) => i % 256));
    const encoded = JSON.parse(encodeMedia("MZ111", audio)) as { media: { payload: string } };
    const frame = parseFrame(
      JSON.stringify({
        event: "media",
        streamSid: "MZ111",
        media: { payload: encoded.media.payload, timestamp: "0" },
      }),
    );

    if (frame?.event !== "media") throw new Error("expected a media frame");
    expect(frame.payload.equals(audio)).toBe(true);
  });

  it("encodes marks and clears", () => {
    expect(JSON.parse(encodeMark("MZ111", "greeting-end"))).toEqual({
      event: "mark",
      streamSid: "MZ111",
      mark: { name: "greeting-end" },
    });
    expect(JSON.parse(encodeClear("MZ111"))).toEqual({ event: "clear", streamSid: "MZ111" });
  });
});

describe("toAudioEncoding", () => {
  it("maps the carrier's names onto ours", () => {
    expect(toAudioEncoding("audio/x-mulaw")).toBe("mulaw");
    expect(toAudioEncoding("audio/l16")).toBe("linear16");
  });

  it("returns null rather than guessing at an unknown encoding", () => {
    expect(toAudioEncoding("audio/opus")).toBeNull();
  });
});

describe("renderConnectStream", () => {
  it("uses Connect, not Start, so audio can be played back", () => {
    const twiml = renderConnectStream("wss://example.ngrok-free.app/telephony/media");

    expect(twiml).toContain("<Connect>");
    expect(twiml).not.toContain("<Start>");
    expect(twiml).toContain('url="wss://example.ngrok-free.app/telephony/media"');
  });

  it("ends after Connect so the carrier hangs up when the socket closes", () => {
    expect(renderConnectStream("wss://x/y").trimEnd().endsWith("</Connect></Response>")).toBe(true);
  });

  it("escapes the url rather than interpolating it raw", () => {
    const twiml = renderConnectStream('wss://x/y?a=1&b=2"><Hangup/><Stream url="');

    expect(twiml).toContain("&amp;");
    expect(twiml).not.toContain("<Hangup/>");
  });
});

describe("escapeXml", () => {
  it("escapes every character that can break out of an attribute", () => {
    expect(escapeXml(`<>&'"`)).toBe("&lt;&gt;&amp;&apos;&quot;");
  });
});

describe("leaving one message on an answering machine", () => {
  /**
   * Hanging up silently was the earlier behaviour. It leaves somebody a missed call from
   * an unknown number and tells them nothing, which serves neither them nor the business —
   * and ten words saying who rang and how to call back carry no risk at all, provided
   * nothing private is in them.
   */
  it("says the message and hangs up, with nothing after", () => {
    /* The `<Hangup />` is the point. A document that ends after `<Say>` would return the
       call to whatever came next, which on an answerphone is a machine listening to an
       agent talk to itself until the recording stops. */
    expect(renderVoicemail("Hello, this is Acme.")).toBe(
      "<Response><Say>Hello, this is Acme.</Say><Hangup /></Response>",
    );
  });

  it("escapes an organisation name that would otherwise break the document", () => {
    /* The name comes from organisation configuration. An ampersand in it is ordinary —
       "Smith & Sons" — and unescaped it makes the TwiML invalid, which the carrier answers
       by dropping the call rather than by leaving a broken message. */
    const twiml = renderVoicemail('Ring "Smith & Sons" back <soon>');
    expect(twiml).toContain("&amp;");
    expect(twiml).toContain("&quot;");
    expect(twiml).toContain("&lt;soon&gt;");
    // And no injected verb survives as markup.
    expect(twiml.match(/<Say>/g)).toHaveLength(1);
  });

  it("cannot be made to contain a second verb", () => {
    // Configuration is not markup. An organisation naming itself after a TwiML verb must
    // not be able to add one.
    const twiml = renderVoicemail("</Say><Dial>+2348030000000</Dial><Say>");
    expect(twiml).not.toContain("<Dial>");
    expect(twiml.match(/<Hangup \/>/g)).toHaveLength(1);
  });
});
