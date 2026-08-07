import { Buffer } from "node:buffer";

import { TELEPHONY_AUDIO, type AudioChunk } from "@ansa/shared";
import { describe, expect, it, vi } from "vitest";

import { createElevenLabsTts, toOutputFormat } from "./elevenlabs-tts.provider";

function streamingResponse(chunks: readonly Uint8Array[], holdOpen = false): Response {
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
}

function collect(): { chunks: AudioChunk[]; onAudio: (chunk: AudioChunk) => void } {
  const chunks: AudioChunk[] = [];
  return { chunks, onAudio: (chunk) => chunks.push(chunk) };
}

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
