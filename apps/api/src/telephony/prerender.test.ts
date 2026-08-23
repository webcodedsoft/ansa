import { TELEPHONY_AUDIO } from "@ansa/shared";
import { describe, expect, it } from "vitest";

import { fakeTts, silentLog } from "../orchestrator/fakes";

import { cacheKey, createAudioCache } from "./prerender";

/**
 * The pace a phrase was rendered at, and the pace it is served at, must be the same one.
 *
 * The greeting and the thinking-gap fillers are rendered once and replayed, which is the
 * point of this cache — 959ms measured cold, at the moment the caller is listening hardest.
 * What makes the pace a correctness problem rather than a performance one is that the cache
 * is a single map for the whole process while the pace belongs to an agent. Two agents on
 * the same voice at different speeds are the case that catches it.
 */

const cacheWith = (maxConcurrent = 4) => {
  const tts = fakeTts();
  const audio = createAudioCache({
    tts: tts.provider,
    format: TELEPHONY_AUDIO,
    forSpeech: (text) => text,
    log: silentLog,
    maxConcurrent,
  });
  return { tts, audio };
};

/** The fake produces nothing on its own; a render completes only once its stream does. */
const finish = async (
  tts: ReturnType<typeof fakeTts>,
  pending: Promise<unknown>,
): Promise<void> => {
  await Promise.resolve();
  tts.last().audio(160);
  tts.last().done();
  await pending;
};

describe("rendering a phrase", () => {
  it("synthesises at the pace it was asked for", async () => {
    const { tts, audio } = cacheWith();
    await finish(tts, audio.render("Good afternoon.", "voice-ng", 0.85));

    expect(tts.syntheses[0]?.request.speakingRate).toBe(0.85);
  });

  it("leaves the pace off entirely when there is none", async () => {
    // Not 1.0. A cloned voice keeps its speaker's own pace and pinning it to 1.0 flattens
    // that, which is why the adapter omits the field rather than sending a default.
    const { tts, audio } = cacheWith();
    await finish(tts, audio.render("Good afternoon.", "voice-ng", undefined));

    expect(tts.syntheses[0]?.request.speakingRate).toBeUndefined();
  });

  it("renders once for a phrase already rendered at that pace", async () => {
    const { tts, audio } = cacheWith();
    await finish(tts, audio.render("Good afternoon.", "voice-ng", 0.85));
    await audio.render("Good afternoon.", "voice-ng", 0.85);

    expect(tts.syntheses).toHaveLength(1);
  });
});

describe("two agents, one voice, different paces", () => {
  it("does not serve one agent's pace to the other", async () => {
    // The defect this file exists for. Keyed on voice and words alone the second render is
    // a cache hit, and the slower agent greets its callers at the faster agent's speed.
    const { tts, audio } = cacheWith();
    await finish(tts, audio.render("Good afternoon.", "voice-ng", 0.85));
    await finish(tts, audio.render("Good afternoon.", "voice-ng", 1.1));

    expect(tts.syntheses.map((s) => s.request.speakingRate)).toEqual([0.85, 1.1]);
  });

  it("keeps the voice's own pace apart from a set one", async () => {
    const { tts, audio } = cacheWith();
    await finish(tts, audio.render("Good afternoon.", "voice-ng", undefined));
    await finish(tts, audio.render("Good afternoon.", "voice-ng", 0.85));

    expect(tts.syntheses).toHaveLength(2);
  });
});

describe("the cache key", () => {
  it("separates every field that changes the bytes", () => {
    const keys = new Set([
      cacheKey("voice-a", undefined, "hello"),
      cacheKey("voice-b", undefined, "hello"),
      cacheKey("voice-a", 0.85, "hello"),
      cacheKey("voice-a", undefined, "goodbye"),
    ]);

    expect(keys.size).toBe(4);
  });

  it("does not confuse the voice's own pace with a rate", () => {
    // `own` rather than an empty string, so the two cannot produce one key.
    expect(cacheKey("voice-a", undefined, "hello")).not.toBe(cacheKey("voice-a", 1, "hello"));
  });
});

/**
 * What the vendor's account limit costs if the cache ignores it.
 *
 * ElevenLabs answers 429 `concurrent_limit_exceeded` above the subscription ceiling. A warm
 * that fired every phrase at once lost six of them to that, and a lost phrase is not a
 * retry — it is synthesised live on every later call. Both tests below are that failure.
 */
describe("how many renders may be open at once", () => {
  it("holds requests above the ceiling until a slot frees", async () => {
    const { tts, audio } = cacheWith(2);

    const pending = [
      audio.render("one", "voice-ng", undefined),
      audio.render("two", "voice-ng", undefined),
      audio.render("three", "voice-ng", undefined),
    ];
    await Promise.resolve();
    await Promise.resolve();

    // The third never reached the provider: two slots, two synthesis requests.
    expect(tts.syntheses).toHaveLength(2);

    tts.syntheses[0]?.audio(160);
    tts.syntheses[0]?.done();
    await pending[0];
    await Promise.resolve();
    await Promise.resolve();

    expect(tts.syntheses).toHaveLength(3);

    for (const synthesis of tts.syntheses.slice(1)) {
      synthesis.audio(160);
      synthesis.done();
    }
    await Promise.all(pending);
  });

  it("frees the slot when a render fails", async () => {
    /* Otherwise one vendor error permanently shrinks the pool, and enough of them wedge
       every later render behind a semaphore nothing will ever release. */
    const { tts, audio } = cacheWith(1);

    const first = audio.render("one", "voice-ng", undefined);
    await Promise.resolve();
    tts.syntheses[0]?.fail("elevenlabs said no");
    expect(await first).toBeNull();

    const second = audio.render("two", "voice-ng", undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(tts.syntheses).toHaveLength(2);

    tts.syntheses[1]?.audio(160);
    tts.syntheses[1]?.done();
    expect(await second).not.toBeNull();
  });
});

describe("the same phrase asked for twice at once", () => {
  it("synthesises it once and gives both callers the same audio", async () => {
    /* The gateway warms two openings for one voice and both walk the same filler list.
       Neither has populated the cache yet, so without this every phrase is synthesised,
       logged and billed twice — visible as paired `pre-rendered phrase` lines for the same
       words with different byte counts. */
    const { tts, audio } = cacheWith();

    const first = audio.render("Mm-hm.", "voice-ng", 0.95);
    const second = audio.render("Mm-hm.", "voice-ng", 0.95);
    await Promise.resolve();

    expect(tts.syntheses).toHaveLength(1);

    tts.syntheses[0]?.audio(160);
    tts.syntheses[0]?.done();

    expect(await first).toBe(await second);
  });

  it("still separates two paces for the same words", async () => {
    // The pace is part of what is being rendered. Coalescing on the words alone would
    // hand one agent the other's speed, which is the bug the cache key already guards.
    const { tts, audio } = cacheWith();

    const slow = audio.render("Mm-hm.", "voice-ng", 0.85);
    const fast = audio.render("Mm-hm.", "voice-ng", 1.0);
    await Promise.resolve();

    expect(tts.syntheses).toHaveLength(2);
    for (const synthesis of tts.syntheses) {
      synthesis.audio(160);
      synthesis.done();
    }
    await Promise.all([slow, fast]);
    expect(tts.syntheses.map((s) => s.request.speakingRate)).toEqual([0.85, 1.0]);
  });
});
