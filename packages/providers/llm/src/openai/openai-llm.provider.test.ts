import { describe, expect, it, vi } from "vitest";

import { createOpenAiLlm, parseSseLine } from "./openai-llm.provider";

const sse = (chunks: readonly string[], holdOpen = false): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) {
          controller.enqueue(enc.encode(c));
          await new Promise((r) => setTimeout(r, 1));
        }
        if (!holdOpen) controller.close();
      },
    }),
    { status: 200 },
  );

const delta = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`;

describe("parseSseLine", () => {
  it("extracts content deltas", () => {
    expect(parseSseLine(delta("Hello").trim())).toBe("Hello");
  });

  it("ignores frames that carry no content", () => {
    expect(parseSseLine("data: [DONE]")).toBeNull();
    expect(parseSseLine(":keepalive")).toBeNull();
    expect(parseSseLine("")).toBeNull();
    expect(parseSseLine('data: {"choices":[{"delta":{"role":"assistant"}}]}')).toBeNull();
    expect(parseSseLine("data: not json")).toBeNull();
  });
});

describe("createOpenAiLlm", () => {
  it("streams deltas as they arrive and reports the full text once", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sse([delta("Your policy "), delta("renews in May.")]));
    const llm = createOpenAiLlm({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });

    const seen: string[] = [];
    const stream = llm.complete({ system: "be brief", messages: [{ role: "user", content: "hi" }] });
    stream.onDelta((t) => seen.push(t));
    const full = await new Promise<string>((resolve) => stream.onDone(resolve));

    expect(seen).toEqual(["Your policy ", "renews in May."]);
    expect(full).toBe("Your policy renews in May.");
  });

  // A network chunk can split an SSE frame mid-line. Losing that frame drops words out
  // of the middle of a spoken sentence, which is worse than a visible failure.
  it("reassembles a delta split across two network chunks", async () => {
    const line = delta("interrupted");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sse([line.slice(0, 20), line.slice(20), delta(" fine")]));
    const llm = createOpenAiLlm({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });

    const stream = llm.complete({ system: "s", messages: [] });
    const full = await new Promise<string>((resolve) => stream.onDone(resolve));

    expect(full).toBe("interrupted fine");
  });

  it("sends the system prompt and messages in order", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sse([delta("ok")]));
    const llm = createOpenAiLlm({ apiKey: "k-1", model: "m-1", fetchImpl: fetchImpl as typeof fetch });

    const stream = llm.complete({
      system: "you are Ansa",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      maxTokens: 42,
    });
    await new Promise<string>((resolve) => stream.onDone(resolve));

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("m-1");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(42);
    expect(body.messages).toEqual([
      { role: "system", content: "you are Ansa" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k-1");
  });

  it("caps turn length by default, because the model will drift long", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sse([delta("ok")]));
    const llm = createOpenAiLlm({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
    await new Promise<string>((resolve) =>
      llm.complete({ system: "s", messages: [] }).onDone(resolve),
    );

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).max_tokens).toBe(120);
  });

  it("surfaces a non-2xx through onError rather than as a rejection", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 429 }));
    const llm = createOpenAiLlm({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });

    const stream = llm.complete({ system: "s", messages: [] });
    const error = await new Promise<Error>((resolve) => stream.onError(resolve));

    expect(error.message).toContain("429");
  });

  describe("cancel", () => {
    it("aborts the request so the vendor stops generating", async () => {
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn().mockImplementation((_u: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return Promise.resolve(sse([delta("a")], true));
      });
      const llm = createOpenAiLlm({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });

      const stream = llm.complete({ system: "s", messages: [] });
      await new Promise((r) => setTimeout(r, 5));
      stream.cancel();

      expect(signal?.aborted).toBe(true);
    });

    // Barge-in: text generated after the caller interrupted describes a reply they
    // never heard. If it reached the history the agent would reference it later.
    it("emits no further deltas and no done after cancelling", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(sse(Array.from({ length: 50 }, (_, i) => delta(`w${i} `)), true));
      const llm = createOpenAiLlm({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });

      const seen: string[] = [];
      const done = vi.fn();
      const errored = vi.fn();
      const stream = llm.complete({ system: "s", messages: [] });
      stream.onDelta((t) => seen.push(t));
      stream.onDone(done);
      stream.onError(errored);

      await new Promise((r) => setTimeout(r, 10));
      const before = seen.length;
      stream.cancel();
      await new Promise((r) => setTimeout(r, 30));

      expect(before).toBeGreaterThan(0);
      expect(seen).toHaveLength(before);
      expect(done).not.toHaveBeenCalled();
      expect(errored).not.toHaveBeenCalled();
    });
  });
});
