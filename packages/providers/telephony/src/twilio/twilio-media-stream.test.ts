import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import type { MediaSocket } from "../types";
import { TwilioMediaStream } from "./twilio-media-stream";

/**
 * Read off the call at 15:36 on 2026-08-23.
 *
 * `missingMs` counted 27.5 seconds of caller audio that Twilio numbered and we never
 * received, out of a 39-second stream — and every one of those seconds was lost while the
 * agent was speaking. 4.3s during the greeting, 13.6s during one recovery line, 9.6s
 * during the next, nothing in between. The carrier discards inbound media it cannot hand
 * over, so an outbound burst is a deaf agent.
 */

const socket = () => {
  const sent: string[] = [];
  const media: MediaSocket = {
    send: (data: string) => sent.push(data),
    close: () => {},
  } as unknown as MediaSocket;
  return { media, sent, kinds: () => sent.map((s) => (JSON.parse(s) as { event: string }).event) };
};

const stream = (s: MediaSocket) =>
  new TwilioMediaStream(s, "MZ1", "CA1", { encoding: "mulaw", sampleRate: 8000 });

/** One 20ms frame of 8kHz mu-law, exactly what the carrier deals in. */
const frame = () => ({ data: Buffer.alloc(160, 0xff), timestampMs: 0 }) as never;

describe("pacing outbound audio", () => {
  it("hands the carrier a lead and then stops, rather than sending a whole turn at once", () => {
    vi.useFakeTimers();
    try {
      const { media, sent } = socket();
      const call = stream(media);
      // Nine seconds of audio, the length of the greeting on that call.
      for (let i = 0; i < 450; i += 1) call.send(frame());

      // 500ms of lead is 25 frames. The rest waits.
      expect(sent.length).toBeLessThanOrEqual(26);
      expect(sent.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps handing it over as the audio plays out", () => {
    vi.useFakeTimers();
    try {
      const { media, sent } = socket();
      const call = stream(media);
      for (let i = 0; i < 450; i += 1) call.send(frame());
      const atStart = sent.length;

      vi.advanceTimersByTime(2000);

      expect(sent.length).toBeGreaterThan(atStart);
      // Still paced: two seconds in, nowhere near all nine seconds have gone.
      expect(sent.length).toBeLessThan(450);
    } finally {
      vi.useRealTimers();
    }
  });

  it("eventually sends every frame", () => {
    vi.useFakeTimers();
    try {
      const { media, sent } = socket();
      const call = stream(media);
      for (let i = 0; i < 450; i += 1) call.send(frame());

      vi.advanceTimersByTime(20_000);

      expect(sent).toHaveLength(450);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what must not be delayed", () => {
  it("keeps a mark behind the audio it belongs to", () => {
    /* A mark is how the carrier reports that a sentence finished playing. One that
       overtakes its frames reports the wrong moment, and barge-in decides what the caller
       heard from exactly that. */
    vi.useFakeTimers();
    try {
      const { media, kinds } = socket();
      const call = stream(media);
      for (let i = 0; i < 450; i += 1) call.send(frame());
      call.mark("end-of-sentence");

      expect(kinds()).not.toContain("mark");

      vi.advanceTimersByTime(20_000);
      expect(kinds().at(-1)).toBe("mark");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears instantly and drops what was never sent", () => {
    /* Barge-in. `clear` tells the carrier to discard what it holds; what is still queued
       here it has never seen, so it has to go on this side or the agent resumes the
       sentence it was interrupted out of. */
    vi.useFakeTimers();
    try {
      const { media, kinds, sent } = socket();
      const call = stream(media);
      for (let i = 0; i < 450; i += 1) call.send(frame());
      const beforeClear = sent.length;

      call.clear();
      expect(kinds().at(-1)).toBe("clear");

      vi.advanceTimersByTime(20_000);
      // Nothing more went out: one clear, and not the other 425 frames.
      expect(sent).toHaveLength(beforeClear + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing more once the call has ended", () => {
    vi.useFakeTimers();
    try {
      const { media, sent } = socket();
      const call = stream(media);
      for (let i = 0; i < 450; i += 1) call.send(frame());
      const atEnd = sent.length;

      call.emitClosed("carrier sent stop");
      vi.advanceTimersByTime(20_000);

      expect(sent).toHaveLength(atEnd);
    } finally {
      vi.useRealTimers();
    }
  });
});
