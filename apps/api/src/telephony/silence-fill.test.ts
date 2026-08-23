import { describe, expect, it } from "vitest";

import type { AudioChunk } from "@ansa/shared";

import { createSilenceFill, GAP_THRESHOLD_MS, MAX_FILL_MS } from "./silence-fill";

/**
 * The call of 2026-08-23 21:15, in miniature.
 *
 * The caller spoke, the carrier stopped sending the moment they stopped talking, Flux never
 * saw the silence its end-of-turn timeout measures, and the line was dead for 25 seconds.
 * Every test here is a piece of that.
 */

const FRAME_MS = 20;

/** A controllable clock and timer queue, so nothing here waits on the real one. */
const harness = () => {
  let clock = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const emitted: AudioChunk[] = [];

  const fill = createSilenceFill({
    format: { encoding: "mulaw", sampleRate: 8000 },
    frameMs: FRAME_MS,
    emit: (chunk) => emitted.push(chunk),
    now: () => clock,
    schedule: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { at: clock + ms, fn });
      return id as unknown as NodeJS.Timeout;
    },
    cancel: (handle) => {
      pending.delete(handle as unknown as number);
    },
  });

  const advance = (ms: number): void => {
    const until = clock + ms;
    for (;;) {
      const due = [...pending.entries()]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      pending.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = until;
  };

  return { fill, emitted, advance };
};

const frame = (offsetMs: number): AudioChunk => ({ data: Buffer.alloc(160, 0x40), offsetMs });

describe("a carrier that stops sending when the caller stops talking", () => {
  it("invents nothing while frames keep arriving", () => {
    const h = harness();
    for (let at = 0; at < 400; at += FRAME_MS) {
      h.fill.seen(frame(at));
      h.advance(FRAME_MS);
    }
    expect(h.emitted).toEqual([]);
  });

  it("starts filling once the frames stop", () => {
    const h = harness();
    h.fill.seen(frame(0));
    h.advance(GAP_THRESHOLD_MS + FRAME_MS * 3);

    // One at the threshold, then one per frame period.
    expect(h.emitted.length).toBeGreaterThanOrEqual(3);
  });

  it("does not fill for ordinary jitter", () => {
    /* A frame arriving a little late is a normal network, not a silent caller. Filling on
       that would feed the detector silence in the middle of somebody's sentence. */
    const h = harness();
    h.fill.seen(frame(0));
    h.advance(GAP_THRESHOLD_MS - FRAME_MS);
    h.fill.seen(frame(FRAME_MS));

    expect(h.emitted).toEqual([]);
  });

  it("emits real silence, not a buzz", () => {
    // 0x00 is full negative amplitude in mu-law. Getting this wrong feeds the detector a
    // loud tone and guarantees it never finds a turn boundary.
    const h = harness();
    h.fill.seen(frame(0));
    h.advance(GAP_THRESHOLD_MS + FRAME_MS);

    const first = h.emitted[0];
    expect(first).toBeDefined();
    expect([...new Set(first?.data ?? [])]).toEqual([0xff]);
    expect(first?.data).toHaveLength(160);
  });

  it("keeps offsets moving forward across the gap", () => {
    const h = harness();
    h.fill.seen(frame(1000));
    h.advance(GAP_THRESHOLD_MS + FRAME_MS * 4);

    const offsets = h.emitted.map((c) => c.offsetMs);
    expect(offsets[0]).toBe(1020);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(new Set(offsets).size).toBe(offsets.length);
  });

  it("never winds the clock back when a late real frame arrives", () => {
    /* The carrier's offsets and ours are different clocks. A real frame stamped behind the
       silence we already invented must not reorder the stream — echo matching pairs
       segments by offset and starts answering the wrong ones. */
    const h = harness();
    h.fill.seen(frame(1000));
    h.advance(GAP_THRESHOLD_MS + FRAME_MS * 5);
    const highest = Math.max(...h.emitted.map((c) => c.offsetMs));

    h.fill.seen(frame(1040)); // behind what we invented
    h.advance(GAP_THRESHOLD_MS + FRAME_MS * 2);

    const after = h.emitted.slice(-2).map((c) => c.offsetMs);
    expect(Math.min(...after)).toBeGreaterThan(highest);
  });

  it("stops filling a call nobody is on", () => {
    const h = harness();
    h.fill.seen(frame(0));
    h.advance(MAX_FILL_MS + 5_000);

    expect(h.emitted.length).toBeLessThanOrEqual(MAX_FILL_MS / FRAME_MS + 1);
  });

  it("resumes filling after the caller speaks again", () => {
    const h = harness();
    h.fill.seen(frame(0));
    h.advance(GAP_THRESHOLD_MS + FRAME_MS * 2);
    const firstGap = h.emitted.length;

    h.fill.seen(frame(5000));
    expect(h.emitted.length).toBe(firstGap);

    h.advance(GAP_THRESHOLD_MS + FRAME_MS * 2);
    expect(h.emitted.length).toBeGreaterThan(firstGap);
  });

  it("invents nothing more once the call is over", () => {
    const h = harness();
    h.fill.seen(frame(0));
    h.fill.stop();
    h.advance(GAP_THRESHOLD_MS + FRAME_MS * 10);

    expect(h.emitted).toEqual([]);
  });

  it("is not restarted by a frame that lands after the call closed", () => {
    /* A real race, not a hypothetical: the carrier's stop and its last media frame cross
       on the wire. Cancelling the pending timer is not enough on its own — the late frame
       arms a fresh one, and the filler goes on writing into a listen session that has
       already been closed. */
    const h = harness();
    h.fill.seen(frame(0));
    h.fill.stop();
    h.fill.seen(frame(FRAME_MS));
    h.advance(GAP_THRESHOLD_MS + FRAME_MS * 10);

    expect(h.emitted).toEqual([]);
  });
});
