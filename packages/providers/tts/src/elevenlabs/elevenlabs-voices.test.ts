import { describe, expect, it } from "vitest";

import { createElevenLabsVoiceCatalogue } from "./elevenlabs-voices";

const respond = (status: number): typeof fetch =>
  ((async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => "",
    }) as unknown as Response) as unknown as typeof fetch);

const catalogue = (fetchImpl: typeof fetch): ReturnType<typeof createElevenLabsVoiceCatalogue> =>
  createElevenLabsVoiceCatalogue({ apiKey: "test-key", baseUrl: "https://voices.test", fetchImpl });

describe("the voice catalogue", () => {
  it("says yes for a voice the account can speak with", async () => {
    await expect(catalogue(respond(200)).knows("a-voice")).resolves.toBe(true);
  });

  it("says no only on the status that actually means no such voice", async () => {
    await expect(catalogue(respond(404)).knows("a-voice")).resolves.toBe(false);
  });

  /**
   * The distinction the whole check rests on. A rejected key answering "this voice does
   * not exist" would send an organisation to change a voice id that was correct.
   */
  it("rejects rather than reporting an unusable credential as an unknown voice", async () => {
    await expect(catalogue(respond(401)).knows("a-voice")).rejects.toThrow(/401/);
  });

  it("rejects when the account is over its quota", async () => {
    await expect(catalogue(respond(429)).knows("a-voice")).rejects.toThrow(/429/);
  });

  it("escapes the voice id rather than pasting it into a URL", async () => {
    const seen: string[] = [];
    const capture = (async (url: unknown) => {
      seen.push(String(url));
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    await catalogue(capture).knows("../voices");
    expect(seen[0]).toBe("https://voices.test/v1/voices/..%2Fvoices");
  });
});
