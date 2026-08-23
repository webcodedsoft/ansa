import type { AudioChunk, AudioFormat } from "@ansa/shared";

/**
 * Manufactures the silence the caller's network refuses to send.
 *
 * A turn detector decides the caller has finished by hearing them stop. Deepgram Flux's
 * `eot_timeout_ms` is a silence backstop in exactly that sense: it measures quiet *in the
 * audio it receives*. That works because Twilio normally delivers a 20ms frame every 20ms
 * for the life of the call, silence included.
 *
 * Most mobile networks do not. They suppress silence — stop transmitting RTP entirely when
 * nobody is talking — and Twilio can only forward what reaches it. So on those calls the
 * detector receives nothing rather than quiet, its timer never advances, and end-of-turn
 * never comes. The agent waits for a boundary that cannot arrive, and the caller hears
 * nothing after the greeting for the rest of the call.
 *
 * Measured on the call of 2026-08-23 21:15: 223 frames across a 28s stream, arriving only
 * while the caller spoke, no end-of-turn, no second agent turn, 25 seconds of dead line.
 * The event loop was idle throughout — this was never a performance problem.
 *
 * What this does not touch is deliberate. The frame counters, `missingMs` and the call
 * recording all continue to see only what the carrier actually sent: those exist to tell us
 * what happened on the wire, and a diagnostic that counts our own invented frames is
 * worthless. Only the listen providers are fed.
 */

/** μ-law zero. 0x00 is full negative amplitude — a very loud buzz, not silence. */
const MULAW_SILENCE = 0xff;

/** Signed 16-bit PCM zero, for the providers that take linear audio. */
const PCM_SILENCE = 0x00;

/**
 * How long to wait before deciding the carrier has stopped rather than jittered.
 *
 * Five frame periods. Long enough that ordinary network jitter does not trigger it, short
 * enough that the detector's own silence timer starts running promptly once the caller
 * really has gone quiet.
 */
export const GAP_THRESHOLD_MS = 100;

/**
 * How much silence to invent before giving up.
 *
 * A caller who has said nothing for this long is not mid-turn, and something upstream has
 * already failed. Filling forever would keep a dead call's detector busy for as long as the
 * socket stayed open.
 */
export const MAX_FILL_MS = 30_000;

export interface SilenceFillDeps {
  readonly format: AudioFormat;
  readonly frameMs: number;
  /** Where invented frames go. The listen providers, and nothing else. */
  readonly emit: (chunk: AudioChunk) => void;
  readonly now: () => number;
  readonly schedule: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly cancel: (handle: NodeJS.Timeout) => void;
}

export interface SilenceFill {
  /** Call for every real frame. Stands the filler down and re-arms it. */
  seen(chunk: AudioChunk): void;
  stop(): void;
  /** For assertions and logging: frames invented so far. */
  filled(): number;
}

const silentFrame = (format: AudioFormat, frameMs: number): Buffer => {
  const bytesPerSample = format.encoding === "mulaw" ? 1 : 2;
  const samples = Math.round((format.sampleRate * frameMs) / 1000);
  const byte = format.encoding === "mulaw" ? MULAW_SILENCE : PCM_SILENCE;
  return Buffer.alloc(samples * bytesPerSample, byte);
};

export const createSilenceFill = (deps: SilenceFillDeps): SilenceFill => {
  const frame = silentFrame(deps.format, deps.frameMs);
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  /** Carries on from where the carrier left off, so offsets stay monotonic. */
  let nextOffsetMs = 0;
  let filledMs = 0;
  let frames = 0;

  const disarm = (): void => {
    if (timer !== null) deps.cancel(timer);
    timer = null;
  };

  const tick = (): void => {
    timer = null;
    if (stopped || filledMs >= MAX_FILL_MS) return;

    deps.emit({ data: frame, offsetMs: nextOffsetMs });
    nextOffsetMs += deps.frameMs;
    filledMs += deps.frameMs;
    frames += 1;

    /* One frame per frame period from here, not one per gap. The detector needs a stream,
       and a single frame of silence tells it nothing about how long the quiet has run. */
    timer = deps.schedule(tick, deps.frameMs);
  };

  return {
    seen: (chunk) => {
      if (stopped) return;
      disarm();
      /* Whichever is later. A real frame that arrives behind the silence we already
         invented must not wind the clock backwards, or the offsets stop being ordered and
         echo matching starts pairing the wrong segments. */
      nextOffsetMs = Math.max(nextOffsetMs, chunk.offsetMs + deps.frameMs);
      filledMs = 0;
      timer = deps.schedule(tick, GAP_THRESHOLD_MS);
    },
    stop: () => {
      stopped = true;
      disarm();
    },
    filled: () => frames,
  };
};
