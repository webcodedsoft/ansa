import { describe, expect, it } from "vitest";

import {
  buildUrl,
  encodeAudioChunk,
  encodeCommit,
  MAX_CHUNK_BYTES,
  MIN_CHUNK_BYTES,
  padToFloor,
  parseEvent,
  splitForSend,
} from "./protocol";

const TELEPHONY = { encoding: "mulaw", sampleRate: 8000 } as const;

describe("the connection URL", () => {
  it("carries the rate, depth, channels and language", () => {
    const url = new URL(buildUrl("infer.voice.intron.io", { format: TELEPHONY, language: "en" }));
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/stt/v1/stream");
    expect(url.searchParams.get("sample_rate")).toBe("8000");
    expect(url.searchParams.get("bit_rate")).toBe("16");
    expect(url.searchParams.get("num_channels")).toBe("1");
    expect(url.searchParams.get("use_language_asr_input")).toBe("en");
  });

  it("sends the transcode's rate when one is given, not the carrier's", () => {
    const url = new URL(
      buildUrl("infer.voice.intron.io", { format: TELEPHONY, language: "pcm", sampleRate: 16_000 }),
    );
    expect(url.searchParams.get("sample_rate")).toBe("16000");
  });

  it("takes the code-switched Nigerian models", () => {
    for (const language of ["pcm", "yo", "ig", "ha"] as const) {
      const url = new URL(buildUrl("host", { format: TELEPHONY, language }));
      expect(url.searchParams.get("use_language_asr_input")).toBe(language);
    }
  });
});

describe("what goes out", () => {
  it("base64-encodes the audio inside JSON, not as a binary frame", () => {
    const frame = JSON.parse(encodeAudioChunk(Buffer.from([0x01, 0x02, 0x03]), 7)) as Record<
      string,
      unknown
    >;
    expect(frame["message_type"]).toBe("INPUT_AUDIO_CHUNK");
    expect(frame["ack_id"]).toBe(7);
    expect(Buffer.from(String(frame["audio_base_64"]), "base64")).toEqual(
      Buffer.from([0x01, 0x02, 0x03]),
    );
  });

  it("commits with no payload", () => {
    expect(JSON.parse(encodeCommit())).toEqual({ message_type: "COMMIT" });
  });
});

describe("reading what comes back", () => {
  it("reads the rate the server actually applied, not the one we asked for", () => {
    /* The only way to discover that a requested 8000 was coerced. Asserting the request
       would prove nothing about what is being transcribed. */
    const event = parseEvent(
      JSON.stringify({
        message_type: "SESSION_CREATED",
        session_id: "abc",
        configs: { sample_rate: 16000, bit_rate: 16, num_channels: 1 },
      }),
    );
    expect(event).toEqual({ kind: "ready", sessionId: "abc", sampleRate: 16000 });
  });

  it("takes a partial as interim", () => {
    expect(parseEvent(JSON.stringify({ message_type: "PARTIAL_TRANSCRIPT", transcript: "my name is" })))
      .toEqual({ kind: "interim", text: "my name is" });
  });

  it("takes a commit from transcript_text, which is not the partial's field name", () => {
    /* The two messages name their text differently. Reading `transcript` on a commit
       returns undefined and drops the whole turn, silently. */
    expect(
      parseEvent(
        JSON.stringify({
          message_type: "COMMITTED_TRANSCRIPT",
          transcript_id: "t1",
          transcript_text: "my name is Sikiru",
          audio_len: 10,
        }),
      ),
    ).toEqual({ kind: "final", text: "my name is Sikiru" });
  });

  it("recognises the session ceiling, which needs a reconnect rather than a failure", () => {
    expect(parseEvent(JSON.stringify({ message_type: "SESSION_TIME_LIMIT_EXCEEDED" }))).toEqual({
      kind: "expired",
    });
  });

  it("ignores an empty transcript rather than emitting a blank turn", () => {
    expect(parseEvent(JSON.stringify({ message_type: "PARTIAL_TRANSCRIPT", transcript: "" }))).toBeNull();
    expect(
      parseEvent(JSON.stringify({ message_type: "COMMITTED_TRANSCRIPT", transcript_text: "" })),
    ).toBeNull();
  });

  it("returns null for a malformed frame rather than throwing", () => {
    /* A throw here would end the call. The caller is still talking and the next frame is
       very likely fine. */
    expect(parseEvent("not json")).toBeNull();
    expect(parseEvent("[]")).toBeNull();
    expect(parseEvent("{}")).toBeNull();
  });

  it("names an unknown message instead of swallowing it", () => {
    expect(parseEvent(JSON.stringify({ message_type: "SOMETHING_NEW" }))).toEqual({
      kind: "other",
      type: "SOMETHING_NEW",
    });
  });
});

describe("batching Twilio's frames up to Intron's floor", () => {
  it("holds audio back until there is a kilobyte of it", () => {
    // 20ms of mu-law is 160 bytes. Sending it raw is under the floor every time.
    const { send, rest } = splitForSend(Buffer.alloc(320));
    expect(send).toEqual([]);
    expect(rest.length).toBe(320);
  });

  it("sends once the floor is reached and keeps the remainder", () => {
    const { send, rest } = splitForSend(Buffer.alloc(MIN_CHUNK_BYTES + 100));
    expect(send).toHaveLength(1);
    expect(send[0]?.length).toBe(MIN_CHUNK_BYTES + 100);
    expect(rest.length).toBe(0);
  });

  it("never exceeds the ceiling in one message", () => {
    const { send, rest } = splitForSend(Buffer.alloc(MAX_CHUNK_BYTES * 2 + 500));
    for (const chunk of send) expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    expect(send.reduce((n, c) => n + c.length, 0) + rest.length).toBe(MAX_CHUNK_BYTES * 2 + 500);
  });

  it("loses no audio across repeated writes", () => {
    /* The property that matters: every byte written eventually goes out, in order. A
       dropped remainder is a clipped word nobody can see in a log. */
    let pending: Buffer = Buffer.alloc(0);
    const sent: Buffer[] = [];
    for (let i = 0; i < 40; i += 1) {
      pending = Buffer.concat([pending, Buffer.alloc(160, i)]);
      const step = splitForSend(pending);
      sent.push(...step.send);
      pending = step.rest;
    }
    expect(Buffer.concat([...sent, pending]).length).toBe(40 * 160);
  });
});

describe("the chunk acknowledgement", () => {
  it("names the vendor's misspelled ack rather than reporting it as unknown", () => {
    /* Undocumented, and one arrives per chunk — roughly every 100ms of a call. Left
       unnamed it is the noisiest line in the log. */
    expect(parseEvent(JSON.stringify({ message_type: "AUDIO_CHUCK_ACK", ack_id: 3 }))).toEqual({
      kind: "ack",
    });
  });

  it("also accepts the spelling they may fix it to", () => {
    expect(parseEvent(JSON.stringify({ message_type: "AUDIO_CHUNK_ACK" }))).toEqual({ kind: "ack" });
  });
});

describe("the chunk floor", () => {
  it("pads a short tail with silence instead of sending it short", () => {
    const padded = padToFloor(Buffer.alloc(100, 0x7f));
    expect(padded.length).toBe(MIN_CHUNK_BYTES);
    // Zeros are PCM16 silence, so nothing audible is added.
    expect(padded.subarray(100).every((b) => b === 0)).toBe(true);
  });

  it("leaves a chunk that already clears the floor alone", () => {
    const full = Buffer.alloc(MIN_CHUNK_BYTES + 5, 0x01);
    expect(padToFloor(full)).toBe(full);
  });

  it("names the three refusals that cannot be retried", () => {
    for (const type of ["CHUNK_SIZE_TOO_SMALL", "CHUNK_ID_MISMATCH_WITH_TOTAL", "INPUT_ERROR"]) {
      expect(parseEvent(JSON.stringify({ message_type: type }))).toEqual({
        kind: "desynced",
        detail: type,
      });
    }
  });
});
