import { Buffer } from "node:buffer";

import { TELEPHONY_AUDIO, type AudioChunk } from "@ansa/shared";
import { describe, expect, it, vi } from "vitest";

import {
  createCartesiaTts,
  parseCartesiaLine,
  toCartesiaOutputFormat,
} from "./cartesia-tts.provider";

/**
 * The second TTS adapter, written to be compared against the first.
 *
 * Most of what is asserted here is not "does Cartesia work" — it is "does this adapter
 * behave the way the ElevenLabs one behaves". A barge-in that stops half a beat later, a
 * `done` fired twice, a speaking rate resolved from somewhere else: any of those turns the
 * A/B into a measurement of the adapters rather than the vendors. `VendorSynthesisStream`
 * makes the lifecycle shared; these cover the wire.
 */

const GREETING = "Thank you for calling Ansa.";

/** SSE frames as the vendor sends them: one `data:` line each, blank line between. */
const sse = (frames: readonly unknown[], holdOpen = false): Response => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (!holdOpen) controller.close();
    },
  });
  return new Response(body, { status: 200 });
};

const chunk = (bytes: readonly number[]): unknown => ({
  type: "chunk",
  done: false,
  data: Buffer.from(bytes).toString("base64"),
});

const DONE = { type: "done", done: true };

const collect = (): { chunks: AudioChunk[]; onAudio: (chunk: AudioChunk) => void } => {
  const chunks: AudioChunk[] = [];
  return { chunks, onAudio: (c) => chunks.push(c) };
};

const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> => {
  const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
};

describe("toCartesiaOutputFormat", () => {
  it("asks for raw mu-law at 8kHz, which is what the carrier speaks", () => {
    // `raw` and not `wav`: a header on a stream reaches the carrier as audio.
    expect(toCartesiaOutputFormat(TELEPHONY_AUDIO)).toEqual({
      container: "raw",
      encoding: "pcm_mulaw",
      sample_rate: 8000,
    });
  });

  it("throws rather than falling back on a format it cannot emit natively", () => {
    /* A silent fallback here reintroduces the transcoding hop R4.2.4 exists to avoid — and
       for mu-law specifically, the wrong sample rate is not a fallback at all: the carrier
       plays it at the wrong speed and nothing reports an error. */
    expect(() => toCartesiaOutputFormat({ encoding: "mulaw", sampleRate: 16000 })).toThrow(
      /no native output/,
    );
    expect(() => toCartesiaOutputFormat({ encoding: "linear16", sampleRate: 12000 })).toThrow(
      /no native output/,
    );
  });
});

describe("parseCartesiaLine", () => {
  it("reads a data line", () => {
    expect(parseCartesiaLine('data: {"type":"done","done":true}')?.type).toBe("done");
  });

  it("ignores everything that is not one", () => {
    // Comments, event lines and the blank separators all arrive here.
    expect(parseCartesiaLine(": keep-alive")).toBeNull();
    expect(parseCartesiaLine("event: message")).toBeNull();
    expect(parseCartesiaLine("")).toBeNull();
    expect(parseCartesiaLine("data:")).toBeNull();
  });

  it("drops a frame it cannot read rather than failing the turn", () => {
    /* The stream carries timestamp and phoneme frames nobody here asked for, and the vendor
       is free to add more. Throwing on an unknown or malformed frame would end a call over
       a field this code never reads. */
    expect(parseCartesiaLine("data: {not json")).toBeNull();
    expect(parseCartesiaLine('data: {"no":"type"}')).toBeNull();
  });
});

describe("createCartesiaTts", () => {
  it("posts to the SSE endpoint with the key, the pinned version and the pinned model", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sse([chunk([1, 2]), DONE]));
    const tts = createCartesiaTts({ apiKey: "sk_car_123", fetchImpl: fetchImpl as typeof fetch });

    const stream = tts.synthesize({ text: GREETING, voiceId: "voice-abc", format: TELEPHONY_AUDIO });
    await new Promise<void>((resolve) => stream.onDone(resolve));

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe("https://api.cartesia.ai/tts/sse");
    expect(headers["Authorization"]).toBe("Bearer sk_car_123");
    /* Dated rather than numbered, and required on every request. Unpinned, the vendor's
       next release changes this integration with no deploy on our side. */
    expect(headers["Cartesia-Version"]).toBe("2026-08-14");
    expect(bodyOf(fetchImpl)).toMatchObject({
      // Pinned, not `sonic-latest`: a floating tag moves what is being measured.
      model_id: "sonic-3",
      transcript: GREETING,
      voice: "voice-abc",
    });
  });

  it("emits each chunk as it arrives rather than buffering the utterance", async () => {
    // The whole point of streaming: sentence two synthesises while sentence one plays.
    const fetchImpl = vi.fn().mockResolvedValue(sse([chunk([1, 2, 3]), chunk([4, 5, 6, 7]), DONE]));
    const tts = createCartesiaTts({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
    const sink = collect();

    const stream = tts.synthesize({ text: GREETING, voiceId: "v", format: TELEPHONY_AUDIO });
    stream.onAudio(sink.onAudio);
    await new Promise<void>((resolve) => stream.onDone(resolve));

    expect(sink.chunks).toHaveLength(2);
    expect(Buffer.concat(sink.chunks.map((c) => c.data))).toEqual(
      Buffer.from([1, 2, 3, 4, 5, 6, 7]),
    );
  });

  it("stamps each chunk with where it starts in the utterance", async () => {
    /* mu-law at 8kHz is one byte per sample, so 800 bytes is 100ms. The orchestrator cuts
       history at a byte offset on barge-in, and this is how one becomes the other. */
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sse([chunk(new Array<number>(800).fill(0)), chunk([9]), DONE]));
    const tts = createCartesiaTts({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
    const sink = collect();

    const stream = tts.synthesize({ text: GREETING, voiceId: "v", format: TELEPHONY_AUDIO });
    stream.onAudio(sink.onAudio);
    await new Promise<void>((resolve) => stream.onDone(resolve));

    expect(sink.chunks.map((c) => c.offsetMs)).toEqual([0, 100]);
  });

  it("splits frames on line boundaries and not on read boundaries", async () => {
    /* A read can land mid-frame. Decoding half a base64 payload puts a burst of noise on
       the call, so the trailing partial has to wait for the rest of it. */
    const encoder = new TextEncoder();
    const whole = `data: ${JSON.stringify(chunk([1, 2, 3, 4]))}\n\ndata: ${JSON.stringify(DONE)}\n\n`;
    const cut = Math.floor(whole.length / 3);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(whole.slice(0, cut)));
        controller.enqueue(encoder.encode(whole.slice(cut)));
        controller.close();
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    const tts = createCartesiaTts({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
    const sink = collect();

    const stream = tts.synthesize({ text: GREETING, voiceId: "v", format: TELEPHONY_AUDIO });
    stream.onAudio(sink.onAudio);
    await new Promise<void>((resolve) => stream.onDone(resolve));

    expect(Buffer.concat(sink.chunks.map((c) => c.data))).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  describe("the speaking rate", () => {
    it("sends the agent's published rate ahead of the deployment default", async () => {
      /* The same precedence as the ElevenLabs adapter. Two adapters resolving this
         differently would make the A/B a comparison of speaking speeds. */
      const fetchImpl = vi.fn().mockResolvedValue(sse([DONE]));
      const tts = createCartesiaTts({
        apiKey: "k",
        speed: 1.1,
        fetchImpl: fetchImpl as typeof fetch,
      });

      const stream = tts.synthesize({
        text: GREETING,
        voiceId: "v",
        speakingRate: 0.95,
        format: TELEPHONY_AUDIO,
      });
      await new Promise<void>((resolve) => stream.onDone(resolve));

      expect(bodyOf(fetchImpl)["generation_config"]).toEqual({ speed: 0.95 });
    });

    it("sends nothing at all when neither set one", async () => {
      // Absent, not defaulted: the model keeps its own pace.
      const fetchImpl = vi.fn().mockResolvedValue(sse([DONE]));
      const tts = createCartesiaTts({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });

      const stream = tts.synthesize({ text: GREETING, voiceId: "v", format: TELEPHONY_AUDIO });
      await new Promise<void>((resolve) => stream.onDone(resolve));

      expect(bodyOf(fetchImpl)).not.toHaveProperty("generation_config");
    });
  });

  describe("when it goes wrong", () => {
    it("reports a refusal with the vendor's own words", async () => {
      /* A wrong voice id lands here, and it is the likely failure: switching provider does
         not switch the id the agent published. */
      const fetchImpl = vi.fn().mockResolvedValue(new Response("voice not found", { status: 404 }));
      const tts = createCartesiaTts({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });

      const stream = tts.synthesize({
        text: GREETING,
        voiceId: "an-elevenlabs-id",
        format: TELEPHONY_AUDIO,
      });
      const error = await new Promise<Error>((resolve) => stream.onError(resolve));

      expect(error.message).toContain("404");
      expect(error.message).toContain("voice not found");
    });

    it("turns an error frame mid-stream into an error rather than a silent end", async () => {
      /* The frame arrives on a 200 with audio already flowing. Treating it as the end of the
         utterance would leave the caller hearing half a sentence and no recovery. */
      const fetchImpl = vi.fn().mockResolvedValue(
        sse([
          chunk([1, 2]),
          { type: "error", done: true, message: "model overloaded", error_code: "capacity" },
        ]),
      );
      const tts = createCartesiaTts({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });

      const stream = tts.synthesize({ text: GREETING, voiceId: "v", format: TELEPHONY_AUDIO });
      const error = await new Promise<Error>((resolve) => stream.onError(resolve));

      expect(error.message).toContain("model overloaded");
      expect(error.message).toContain("capacity");
    });

    it("settles when the body ends without a done frame", async () => {
      /* A connection that closes early must still finish the turn. A synthesis that never
         calls back is a silent call, which is the one outcome this layer must not produce. */
      const fetchImpl = vi.fn().mockResolvedValue(sse([chunk([1, 2])]));
      const tts = createCartesiaTts({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });

      const stream = tts.synthesize({ text: GREETING, voiceId: "v", format: TELEPHONY_AUDIO });
      await expect(new Promise<void>((resolve) => stream.onDone(resolve))).resolves.toBeUndefined();
    });
  });

  describe("barge-in", () => {
    /**
     * A stream this test drives frame by frame.
     *
     * The first version of these two used sleeps, and both passed for nothing: with a 1ms
     * cadence every frame including `done` had already arrived before the cancel, so the
     * stream was settled and `cancel()` was a no-op on an utterance that had finished. The
     * only honest way to test an interruption is to still be mid-utterance when it happens.
     */
    const driven = (): { response: Response; push: (frame: unknown) => Promise<boolean> } => {
      const encoder = new TextEncoder();
      let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          sink = controller;
        },
      });
      return {
        response: new Response(body, { status: 200 }),
        /* False once the adapter has torn the connection down — enqueueing into a cancelled
           stream throws, and that throw is evidence rather than a problem: it is the abort
           having reached the wire, which is half of what a barge-in has to do. */
        push: async (frame) => {
          let accepted = true;
          try {
            sink?.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          } catch {
            accepted = false;
          }
          // Let the adapter's read loop drain whatever was enqueued.
          await new Promise((resolve) => setTimeout(resolve, 5));
          return accepted;
        },
      };
    };

    it("stops emitting audio the moment it is cancelled", async () => {
      /* R6.1. One more chunk after the caller starts talking is the agent talking over
         them, and the guarantee has to be identical in both adapters or the A/B measures
         how fast each one stops. */
      const wire = driven();
      const fetchImpl = vi.fn().mockResolvedValue(wire.response);
      const tts = createCartesiaTts({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
      const sink = collect();

      const stream = tts.synthesize({ text: GREETING, voiceId: "v", format: TELEPHONY_AUDIO });
      stream.onAudio(sink.onAudio);
      await wire.push(chunk([1]));
      // Mid-utterance, with more to come. This is the moment the caller cuts in.
      expect(sink.chunks).toHaveLength(1);

      stream.cancel();

      /* The adapter is parked in `read()` when the cancel lands, so the next frame is what
         wakes it. It drops that frame rather than passing it on, and tears the connection
         down on the way out — which the frame after it proves, because enqueueing into a
         cancelled stream throws. */
      await wire.push(chunk([2]));
      expect(sink.chunks).toHaveLength(1);
      expect(await wire.push(chunk([3]))).toBe(false);

      expect(sink.chunks).toHaveLength(1);
    });

    it("does not report the abort as a failure", async () => {
      /* A barge-in is the caller doing the right thing. Reported as an error it becomes a
         spoken apology for something that was not a fault. */
      const wire = driven();
      const fetchImpl = vi.fn().mockResolvedValue(wire.response);
      const tts = createCartesiaTts({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
      const errors: Error[] = [];
      let finished = false;

      const stream = tts.synthesize({ text: GREETING, voiceId: "v", format: TELEPHONY_AUDIO });
      stream.onError((e) => errors.push(e));
      stream.onDone(() => {
        finished = true;
      });
      await wire.push(chunk([1]));
      stream.cancel();
      await wire.push(chunk([2]));

      expect(errors).toEqual([]);
      // Nor a `done`: the utterance did not finish, it was abandoned.
      expect(finished).toBe(false);
    });
  });
});
