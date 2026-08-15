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

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

/** The three fields of an ElevenLabs entry that this file actually reads back out. */
const onAccount = (voiceId: string, name: string, labels: Record<string, string> = {}) => ({
  voice_id: voiceId,
  name,
  description: "an account voice",
  preview_url: `https://clips.test/${voiceId}.mp3`,
  labels: { accent: "nigerian", gender: "female", ...labels },
});

const inLibrary = (voiceId: string, name: string, freeUsersAllowed: boolean) => ({
  voice_id: voiceId,
  name,
  description: "a library voice",
  preview_url: `https://clips.test/${voiceId}.mp3`,
  accent: "nigerian",
  gender: "male",
  age: "young",
  use_case: "conversational",
  language: "en",
  free_users_allowed: freeUsersAllowed,
});

interface Population {
  readonly voices?: unknown;
  readonly tier?: string;
  readonly library?: unknown;
  /** Statuses to answer with instead of a body, keyed by the part of the path that decides. */
  readonly failing?: Readonly<Record<"voices" | "subscription" | "library", number | undefined>>;
}

/**
 * A fetch that answers all three endpoints the way ElevenLabs does, including the two
 * different label shapes — nested under `labels` on the account, flattened on the library.
 * Getting that wrong is exactly the kind of thing this file exists to absorb.
 */
const account = (population: Population): typeof fetch => {
  const answer = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => "vendor said so",
      json: async () => body,
    }) as unknown as Response;

  return (async (url: unknown) => {
    const path = String(url);
    const failing = population.failing;
    if (path.includes("/v1/user/subscription")) {
      const status = failing?.subscription;
      if (status !== undefined) return answer(status, null);
      return answer(200, { tier: population.tier ?? "starter" });
    }
    if (path.includes("/v1/shared-voices")) {
      const status = failing?.library;
      if (status !== undefined) return answer(status, null);
      return answer(200, { voices: population.library ?? [] });
    }
    const status = failing?.voices;
    if (status !== undefined) return answer(status, null);
    return answer(200, { voices: population.voices ?? [] });
  }) as unknown as typeof fetch;
};

describe("listing the voices worth choosing between", () => {
  it("marks the account's own voices usable and the library's addable", async () => {
    const listing = await catalogue(
      account({
        voices: [onAccount("acct-1", "Olabisi")],
        library: [inLibrary("lib-1", "Toyib", true)],
      }),
    ).list();

    expect(listing.voices.map((voice) => [voice.voiceId, voice.availability])).toEqual([
      ["acct-1", "usable"],
      ["lib-1", "addable"],
    ]);
    expect(listing.libraryUnread).toBe(false);
  });

  /**
   * The three-state answer earning its keep. On a paid plan `free_users_allowed: false` is
   * not a refusal, and greying the voice out would hide most of the library from an account
   * that can add every entry in it.
   */
  it("treats free_users_allowed as a gate only on a free plan", async () => {
    const library = [inLibrary("lib-free", "Free", true), inLibrary("lib-paid", "Paid", false)];

    const paid = await catalogue(account({ tier: "starter", library })).list();
    expect(paid.voices.map((voice) => voice.availability)).toEqual(["addable", "addable"]);

    const free = await catalogue(account({ tier: "free", library })).list();
    expect(free.voices.map((voice) => [voice.name, voice.availability])).toEqual([
      ["Free", "addable"],
      ["Paid", "beyond-plan"],
    ]);
  });

  it("shows a library voice already copied to the account once, as usable", async () => {
    const listing = await catalogue(
      account({
        voices: [onAccount("shared-7", "Olabisi")],
        library: [inLibrary("shared-7", "Olabisi", true)],
      }),
    ).list();

    expect(listing.voices).toHaveLength(1);
    expect(listing.voices[0]?.availability).toBe("usable");
  });

  it("puts what works first, because that is the only group safe to pick from", async () => {
    const listing = await catalogue(
      account({
        tier: "free",
        voices: [onAccount("acct-z", "Zainab")],
        library: [inLibrary("lib-b", "Bendos", false), inLibrary("lib-a", "Amaka", true)],
      }),
    ).list();

    expect(listing.voices.map((voice) => voice.name)).toEqual(["Zainab", "Amaka", "Bendos"]);
  });

  it("reads the library's flattened labels and the account's nested ones the same way", async () => {
    const listing = await catalogue(
      account({
        voices: [onAccount("acct-1", "Olabisi", { age: "young", use_case: "conversational", language: "en" })],
        library: [inLibrary("lib-1", "Toyib", true)],
      }),
    ).list();

    expect(listing.voices[0]?.labels).toEqual({
      accent: "nigerian",
      gender: "female",
      age: "young",
      useCase: "conversational",
      language: "en",
    });
    expect(listing.voices[1]?.labels.useCase).toBe("conversational");
  });

  /**
   * The same distinction `knows` rests on, one screen earlier. An account with no voices is
   * a real and fixable state; an account that could not be read is ours to fix, and a
   * console shown an empty list would send somebody to buy voices they already own.
   */
  it("resolves empty for an account that holds nothing", async () => {
    const listing = await catalogue(account({ voices: [], library: [] })).list();
    expect(listing).toEqual({ voices: [], libraryUnread: false });
  });

  it("rejects rather than resolving empty when the account cannot be read", async () => {
    await expect(
      catalogue(account({ failing: { voices: 401, subscription: undefined, library: undefined } })).list(),
    ).rejects.toThrow(/401/);
  });

  /**
   * The plan is part of reading the account. Without the tier there is no honest answer to
   * "may I add this", and defaulting to yes puts an operator in front of a voice their plan
   * refuses at the moment they try to use it.
   */
  it("rejects when the plan cannot be read, rather than guessing that everything is addable", async () => {
    await expect(
      catalogue(account({ failing: { voices: undefined, subscription: 403, library: undefined } })).list(),
    ).rejects.toThrow(/403/);
  });

  /**
   * The library failing is a smaller loss than the account failing, and the listing says
   * which happened. Everything returned here is still correct and still usable.
   */
  it("keeps the account's voices and says so when the library does not answer", async () => {
    const listing = await catalogue(
      account({
        voices: [onAccount("acct-1", "Olabisi")],
        failing: { voices: undefined, subscription: undefined, library: 500 },
      }),
    ).list();

    expect(listing.libraryUnread).toBe(true);
    expect(listing.voices.map((voice) => voice.voiceId)).toEqual(["acct-1"]);
  });

  it("narrows the library to the accent the deployment asked for", async () => {
    const seen: string[] = [];
    const inner = account({ library: [] });
    const capture = (async (url: unknown, init: unknown) => {
      seen.push(String(url));
      return (inner as unknown as (u: unknown, i: unknown) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    await createElevenLabsVoiceCatalogue({
      apiKey: "test-key",
      baseUrl: "https://voices.test",
      libraryAccent: "south african",
      fetchImpl: capture,
    }).list();

    const library = seen.find((url) => url.includes("/v1/shared-voices"));
    expect(library).toContain("accent=south+african");
    expect(library).toContain("language=en");
  });

  /**
   * The rule that makes the interface worth having. If an ElevenLabs field name reaches a
   * caller, swapping the vendor stops being a one-file change and the console starts
   * reading `voice_id`.
   */
  it("emits no ElevenLabs field name", async () => {
    const listing = await catalogue(
      account({
        voices: [onAccount("acct-1", "Olabisi")],
        library: [inLibrary("lib-1", "Toyib", true)],
      }),
    ).list();

    const vendorNames = ["voice_id", "preview_url", "use_case", "free_users_allowed", "category", "is_added_by_user"];
    for (const voice of listing.voices) {
      expect(Object.keys(voice).sort()).toEqual([
        "availability",
        "description",
        "labels",
        "name",
        "previewUrl",
        "voiceId",
      ]);
      expect(Object.keys(voice.labels).sort()).toEqual([
        "accent",
        "age",
        "gender",
        "language",
        "useCase",
      ]);
      for (const name of vendorNames) expect(Object.hasOwn(voice, name)).toBe(false);
    }
  });

  it("drops an entry with no id rather than offering a row nothing can be said about", async () => {
    const listing = await catalogue(
      account({ voices: [{ name: "nameless" }, onAccount("acct-1", "Olabisi")], library: [] }),
    ).list();

    expect(listing.voices.map((voice) => voice.voiceId)).toEqual(["acct-1"]);
  });
});
