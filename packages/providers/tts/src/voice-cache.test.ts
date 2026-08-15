import { describe, expect, it } from "vitest";

import type { VoiceCatalogue, VoiceListing } from "./types";
import { withCachedListing } from "./voice-cache";

const listing = (libraryUnread: boolean): VoiceListing => ({
  voices: [
    {
      voiceId: "acct-1",
      name: "Olabisi",
      description: null,
      availability: "usable",
      previewUrl: null,
      labels: { accent: "nigerian", gender: "female", age: null, useCase: null, language: "en" },
    },
  ],
  libraryUnread,
});

interface Counted {
  readonly catalogue: VoiceCatalogue;
  readonly calls: () => number;
  readonly knowsCalls: () => number;
}

const counting = (answer: () => Promise<VoiceListing>): Counted => {
  let calls = 0;
  let knowsCalls = 0;
  return {
    catalogue: {
      name: "counted",
      knows: async () => {
        knowsCalls += 1;
        return true;
      },
      list: async () => {
        calls += 1;
        return answer();
      },
    },
    calls: () => calls,
    knowsCalls: () => knowsCalls,
  };
};

/** A clock the test moves by hand, so nothing here waits on a real five minutes. */
const clock = (): { now: () => number; advance: (ms: number) => void } => {
  let at = 1_000;
  return { now: () => at, advance: (ms) => { at += ms; } };
};

describe("the cached listing", () => {
  it("asks the vendor once and serves the same answer after that", async () => {
    const counted = counting(async () => listing(false));
    const cached = withCachedListing(counted.catalogue);

    await cached.list();
    await cached.list();
    await cached.list();

    expect(counted.calls()).toBe(1);
  });

  it("asks again once the answer has expired", async () => {
    const time = clock();
    const counted = counting(async () => listing(false));
    const cached = withCachedListing(counted.catalogue, { ttlMs: 60_000, now: time.now });

    await cached.list();
    time.advance(59_000);
    await cached.list();
    expect(counted.calls()).toBe(1);

    time.advance(2_000);
    await cached.list();
    expect(counted.calls()).toBe(2);
  });

  /**
   * The cache is empty exactly when the load arrives. Without a shared in-flight promise,
   * two tabs opened together are two vendor requests and the cache never helps at the one
   * moment it was added for.
   */
  it("collapses concurrent callers into one request", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const counted = counting(async () => {
      await gate;
      return listing(false);
    });
    const cached = withCachedListing(counted.catalogue);

    const both = Promise.all([cached.list(), cached.list()]);
    release();
    await both;

    expect(counted.calls()).toBe(1);
  });

  /**
   * A five-minute outage that outlives itself is worse than no cache: the operator retries,
   * gets the same failure, and has no way to tell a cached one from a live one.
   */
  it("does not remember a failure", async () => {
    let attempt = 0;
    const counted = counting(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("vendor down");
      return listing(false);
    });
    const cached = withCachedListing(counted.catalogue);

    await expect(cached.list()).rejects.toThrow(/vendor down/);
    await expect(cached.list()).resolves.toEqual(listing(false));
    expect(counted.calls()).toBe(2);
  });

  /** And a rejection must not wedge every later caller onto the settled failed promise. */
  it("recovers rather than replaying a rejection to every caller after it", async () => {
    let attempt = 0;
    const counted = counting(async () => {
      attempt += 1;
      if (attempt <= 2) throw new Error("vendor down");
      return listing(false);
    });
    const cached = withCachedListing(counted.catalogue);

    await expect(Promise.allSettled([cached.list(), cached.list()])).resolves.toHaveLength(2);
    await expect(cached.list()).rejects.toThrow(/vendor down/);
    await expect(cached.list()).resolves.toEqual(listing(false));
  });

  /**
   * A listing missing the library is worth holding — otherwise a broken library means a
   * vendor round trip on every page load — but not for as long, because the moment the
   * library recovers the cached answer shows fewer voices than exist.
   */
  it("holds a partial listing for less time than a complete one", async () => {
    const time = clock();
    const counted = counting(async () => listing(true));
    const cached = withCachedListing(counted.catalogue, { ttlMs: 5 * 60_000, now: time.now });

    await cached.list();
    time.advance(31_000);
    await cached.list();

    expect(counted.calls()).toBe(2);
  });

  /**
   * `knows` is a readiness check and staleness is its entire failure mode: reporting a
   * deleted voice as fine for five minutes is the bug it was written to prevent.
   */
  it("passes knows straight through", async () => {
    const counted = counting(async () => listing(false));
    const cached = withCachedListing(counted.catalogue);

    await cached.knows("a-voice");
    await cached.knows("a-voice");

    expect(counted.knowsCalls()).toBe(2);
  });
});
