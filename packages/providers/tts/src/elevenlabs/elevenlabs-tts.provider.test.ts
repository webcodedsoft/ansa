import { Buffer } from "node:buffer";

import { TELEPHONY_AUDIO, type AudioChunk } from "@ansa/shared";
import { describe, expect, it, vi } from "vitest";

import { createElevenLabsTts, toOutputFormat } from "./elevenlabs-tts.provider";

const streamingResponse = (chunks: readonly Uint8Array[], holdOpen = false): Response => {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (!holdOpen) controller.close();
    },
  });
  return new Response(body, { status: 200 });
};

const collect = (): { chunks: AudioChunk[]; onAudio: (chunk: AudioChunk) => void } => {
  const chunks: AudioChunk[] = [];
  return { chunks, onAudio: (chunk) => chunks.push(chunk) };
};

const GREETING = "Thank you for calling Ansa.";

describe("toOutputFormat", () => {
  it("maps telephony audio to the vendor's mu-law name", () => {
    expect(toOutputFormat(TELEPHONY_AUDIO)).toBe("ulaw_8000");
  });

  // A silent fallback here would reintroduce the transcoding hop R4.2.4 exists to avoid.
  it("throws rather than falling back on an unsupported format", () => {
    expect(() => toOutputFormat({ encoding: "mulaw", sampleRate: 16000 })).toThrow(
      /no native output/,
    );
  });
});

describe("createElevenLabsTts", () => {
  it("requests mu-law 8kHz from the streaming endpoint with the api key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamingResponse([new Uint8Array([1, 2])]));
    const tts = createElevenLabsTts({ apiKey: "k-123", fetchImpl: fetchImpl as typeof fetch });

    const stream = tts.synthesize({
      text: GREETING,
      voiceId: "voice-abc",
      format: TELEPHONY_AUDIO,
    });
    await new Promise<void>((resolve) => stream.onDone(resolve));

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/text-to-speech/voice-abc/stream");
    expect(url).toContain("output_format=ulaw_8000");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("k-123");
    expect(JSON.parse(init.body as string)).toMatchObject({ text: GREETING });
  });

  it("emits each chunk as it arrives rather than buffering the whole utterance", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        streamingResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])]),
      );
    const tts = createElevenLabsTts({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
    const sink = collect();

    const stream = tts.synthesize({
      text: GREETING,
      voiceId: "v",
      format: TELEPHONY_AUDIO,
    });
    stream.onAudio(sink.onAudio);
    await new Promise<void>((resolve) => stream.onDone(resolve));

    expect(sink.chunks).toHaveLength(2);
    expect(Buffer.concat(sink.chunks.map((c) => c.data))).toEqual(
      Buffer.from([1, 2, 3, 4, 5, 6, 7]),
    );
  });

  // 8000 bytes of mu-law at 8kHz is one second, so 3 bytes in is 0ms and the next
  // chunk starts at 3/8 of a millisecond, which rounds to 0. Use a bigger chunk to see it.
  it("stamps each chunk with its offset inside the utterance", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        streamingResponse([new Uint8Array(800), new Uint8Array(1600), new Uint8Array(80)]),
      );
    const tts = createElevenLabsTts({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
    const sink = collect();

    const stream = tts.synthesize({ text: GREETING, voiceId: "v", format: TELEPHONY_AUDIO });
    stream.onAudio(sink.onAudio);
    await new Promise<void>((resolve) => stream.onDone(resolve));

    expect(sink.chunks.map((c) => c.offsetMs)).toEqual([0, 100, 300]);
  });

  it("surfaces a non-2xx response through onError, not as a rejection", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("voice not found", { status: 404 }));
    const tts = createElevenLabsTts({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });

    const stream = tts.synthesize({ text: GREETING, voiceId: "v", format: TELEPHONY_AUDIO });
    const error = await new Promise<Error>((resolve) => stream.onError(resolve));

    expect(error.message).toContain("404");
    expect(error.message).toContain("voice not found");
  });

  it("reports an unsupported format through onError rather than throwing synchronously", async () => {
    const tts = createElevenLabsTts({
      apiKey: "k",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    const stream = tts.synthesize({
      text: GREETING,
      voiceId: "v",
      format: { encoding: "mulaw", sampleRate: 16000 },
    });
    const error = await new Promise<Error>((resolve) => stream.onError(resolve));

    expect(error.message).toMatch(/no native output/);
  });

  /**
   * Which model, and what gets sent about the voice.
   *
   * The model is a latency decision: Flash is ~75ms of inference against Turbo's 250-300,
   * on a budget where the whole turn should land under a second. The voice settings are a
   * different kind of decision — ElevenLabs merges what it is sent over the voice's own
   * stored settings, so sending a default is not neutral, it is an override.
   */
  const bodyOf = async (
    options: Parameters<typeof createElevenLabsTts>[0],
    request: Partial<Parameters<ReturnType<typeof createElevenLabsTts>["synthesize"]>[0]> = {},
  ): Promise<Record<string, unknown>> => {
    const fetchImpl = vi.fn().mockResolvedValue(streamingResponse([new Uint8Array([1])]));
    const tts = createElevenLabsTts({ ...options, fetchImpl: fetchImpl as typeof fetch });
    const stream = tts.synthesize({
      text: GREETING,
      voiceId: "voice-abc",
      format: TELEPHONY_AUDIO,
      ...request,
    });
    await new Promise<void>((resolve) => stream.onDone(resolve));
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string) as Record<string, unknown>;
  };

  describe("the model", () => {
    it("defaults to the flash model, not the deprecated turbo one", async () => {
      expect(await bodyOf({ apiKey: "k" })).toMatchObject({ model_id: "eleven_flash_v2_5" });
    });

    it("can be overridden without a deploy", async () => {
      expect(await bodyOf({ apiKey: "k", modelId: "eleven_turbo_v2_5" })).toMatchObject({
        model_id: "eleven_turbo_v2_5",
      });
    });

    // Deprecated on the streaming endpoint with no replacement. Sending it dates the code
    // and buys nothing; the brief asks for it and the brief is out of date here.
    it("does not send the deprecated latency parameter", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(streamingResponse([new Uint8Array([1])]));
      const tts = createElevenLabsTts({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
      const stream = tts.synthesize({
        text: GREETING,
        voiceId: "v",
        format: TELEPHONY_AUDIO,
      });
      await new Promise<void>((resolve) => stream.onDone(resolve));
      const [url] = fetchImpl.mock.calls[0] as [string];
      expect(url).not.toContain("optimize_streaming_latency");
    });
  });

  describe("voice settings", () => {
    it("sends none at all when none were configured", async () => {
      // The important one. An empty object would still be merged over the voice's stored
      // settings; absence is what leaves a cloned voice as its owner tuned it.
      expect(await bodyOf({ apiKey: "k" })).not.toHaveProperty("voice_settings");
    });

    it("sends only the knobs that were set", async () => {
      const body = await bodyOf({ apiKey: "k", voiceSettings: { stability: 0.45 } });
      expect(body["voice_settings"]).toEqual({ stability: 0.45 });
    });

    it("uses the vendor's snake case", async () => {
      const body = await bodyOf({
        apiKey: "k",
        voiceSettings: { similarityBoost: 0.75, useSpeakerBoost: true, style: 0.35 },
      });
      expect(body["voice_settings"]).toEqual({
        similarity_boost: 0.75,
        use_speaker_boost: true,
        style: 0.35,
      });
    });

    it("lets the agent's own rate beat the deployment default", async () => {
      // The deployment fallback is for agents that published no rate. An agent that did
      // has made a choice, and it is per-agent configuration reaching a call.
      const body = await bodyOf({ apiKey: "k", voiceSettings: { speed: 0.95 } }, {
        speakingRate: 1.1,
      });
      expect(body["voice_settings"]).toEqual({ speed: 1.1 });
    });

    it("falls back to the deployment rate when the agent published none", async () => {
      const body = await bodyOf({ apiKey: "k", voiceSettings: { speed: 0.95 } });
      expect(body["voice_settings"]).toEqual({ speed: 0.95 });
    });
  });

  describe("cancel", () => {
    it("aborts the in-flight request so the vendor stops producing audio", async () => {
      let seenSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        seenSignal = init.signal ?? undefined;
        return Promise.resolve(streamingResponse([new Uint8Array(160)], true));
      });
      const tts = createElevenLabsTts({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });

      const stream = tts.synthesize({ text: GREETING, voiceId: "v", format: TELEPHONY_AUDIO });
      await new Promise((resolve) => setTimeout(resolve, 5));
      stream.cancel();

      expect(seenSignal?.aborted).toBe(true);
    });

    // Barge-in: the caller has started speaking, so nothing further may reach their ear,
    // and the agent must not later act as though the rest of the turn was heard.
    it("emits no further audio and no done after cancelling", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(
          streamingResponse(
            Array.from({ length: 40 }, () => new Uint8Array(160)),
            true,
          ),
        );
      const tts = createElevenLabsTts({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
      const sink = collect();
      const done = vi.fn();
      const errored = vi.fn();

      const stream = tts.synthesize({ text: GREETING, voiceId: "v", format: TELEPHONY_AUDIO });
      stream.onAudio(sink.onAudio);
      stream.onDone(done);
      stream.onError(errored);

      await new Promise((resolve) => setTimeout(resolve, 8));
      const heardBefore = sink.chunks.length;
      stream.cancel();
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(heardBefore).toBeGreaterThan(0);
      expect(sink.chunks).toHaveLength(heardBefore);
      expect(done).not.toHaveBeenCalled();
      // An abort is a barge-in, not a fault.
      expect(errored).not.toHaveBeenCalled();
    });
  });
});
