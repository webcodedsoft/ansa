import { describe, expect, it } from "vitest";

import { createRecordingLinks } from "./recording-links";

/**
 * The credential in the URL (slice 5).
 *
 * An `<audio>` element cannot send an authorization header, so the URL is the only credential
 * the browser can carry — which puts the whole burden on the ticket being unguessable, spent
 * once, and short-lived. These are those three properties, and each one failing is a way for a
 * stranger to hear somebody's voice.
 */
describe("a ticket to a call's audio", () => {
  it("works once and then does not", () => {
    /* The property that matters most. A ticket that survived its first use would sit in a
       browser history, a proxy log and a shared screenshot, still working. */
    const links = createRecordingLinks();
    const token = links.offer("CA-one");

    expect(links.take(token)).toBe("CA-one");
    expect(links.take(token)).toBeNull();
  });

  it("expires whether or not anybody used it", () => {
    let clock = 1_000;
    const links = createRecordingLinks({ ttlMs: 500, now: () => clock });
    const token = links.offer("CA-two");

    clock += 499;
    expect(links.take(token)).toBe("CA-two");

    const second = links.offer("CA-three");
    clock += 501;
    expect(links.take(second)).toBeNull();
  });

  it("says nothing different about a token that never existed", () => {
    /* Unknown, expired and spent are one answer. Three would let a prober learn that a given
       call exists and was recorded, which is most of what they wanted to know. */
    const links = createRecordingLinks();
    expect(links.take("never-minted")).toBeNull();
    expect(links.take("")).toBeNull();
  });

  it("mints something no one could guess, and never the same twice", () => {
    const links = createRecordingLinks();
    const tokens = new Set(Array.from({ length: 200 }, () => links.offer("CA-same")));

    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      // 128 bits as hex. Not a counter, and nothing derived from the call it names.
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(token).not.toContain("CA-same");
    }
  });

  it("keeps two calls' tickets apart", () => {
    const links = createRecordingLinks();
    const first = links.offer("CA-first");
    const second = links.offer("CA-second");

    expect(links.take(second)).toBe("CA-second");
    // Spending one leaves the other alone.
    expect(links.take(first)).toBe("CA-first");
  });

  it("forgets expired tickets rather than holding them for the life of the process", () => {
    /* A registry that only deletes on `take` grows for every link nobody clicked, and this one
       lives as long as the API does. */
    let clock = 0;
    const links = createRecordingLinks({ ttlMs: 100, now: () => clock });
    const abandoned = links.offer("CA-abandoned");

    clock += 1_000;
    links.offer("CA-fresh"); // any use of the registry sweeps
    expect(links.take(abandoned)).toBeNull();
  });
});
