import type { AudioChunk, AudioFormat, CallId } from "@ansa/shared";
import { asCallId } from "@ansa/shared";

import type { CallMediaStream, MediaSocket } from "../types";
import { encodeClear, encodeMark, encodeMedia } from "./protocol";

/**
 * How much audio the carrier may hold ahead of real time.
 *
 * Outbound used to go the moment it existed: a nine-second greeting left as fast as the
 * socket would take it. Measured on the call at 15:36, inbound audio was only ever lost
 * while the agent was speaking — 4.3s during the greeting, 13.6s during one recovery
 * line, 9.6s during the next, and nothing at all in between. The carrier discards inbound
 * media it cannot hand over, so our own burst was deafening us.
 *
 * Half a second is enough to ride out jitter and short enough that barge-in throws away
 * very little: `clear` discards whatever is still queued there, and that used to be
 * measured in seconds.
 */
const CARRIER_LEAD_MS = 500;

/** Milliseconds of audio in a frame. 8-bit mu-law is one byte per sample. */
const audioMs = (bytes: number, format: AudioFormat): number =>
  (bytes / (format.encoding === "mulaw" ? 1 : 2) / format.sampleRate) * 1000;

export class TwilioMediaStream implements CallMediaStream {
  readonly callId: CallId;
  readonly format: AudioFormat;
  readonly parameters: Readonly<Record<string, string>>;

  private readonly socket: MediaSocket;
  private readonly streamSid: string;
  private readonly audioListeners: ((chunk: AudioChunk) => void)[] = [];
  private readonly markListeners: ((name: string) => void)[] = [];
  private readonly digitListeners: ((digit: string) => void)[] = [];
  private readonly closedListeners: ((reason: string) => void)[] = [];
  private closed = false;
  /** Wall clock up to which the carrier already has audio. */
  private sentUntilMs = 0;
  /** Frames and marks waiting for the carrier to catch up, in the order they were given. */
  private readonly outbound: (
    | { readonly kind: "media"; readonly data: Buffer }
    | { readonly kind: "mark"; readonly name: string }
  )[] = [];
  private draining: ReturnType<typeof setTimeout> | null = null;

  constructor(
    socket: MediaSocket,
    streamSid: string,
    callSid: string,
    format: AudioFormat,
    parameters: Readonly<Record<string, string>> = {},
  ) {
    this.socket = socket;
    this.streamSid = streamSid;
    this.callId = asCallId(callSid);
    this.format = format;
    this.parameters = parameters;
  }

  onAudio(listener: (chunk: AudioChunk) => void): void {
    this.audioListeners.push(listener);
  }

  send(chunk: AudioChunk): void {
    if (this.closed) return;
    this.outbound.push({ kind: "media", data: chunk.data });
    this.drain();
  }

  mark(name: string): void {
    if (this.closed) return;
    /* Queued behind the audio rather than sent past it. A mark is how the carrier reports
       that a sentence finished playing, so one that overtakes the frames it belongs to
       reports the wrong moment — and barge-in decides what the caller heard from it. */
    this.outbound.push({ kind: "mark", name });
    this.drain();
  }

  /**
   * Hand over as much as the carrier should hold, then wait.
   *
   * Marks carry no duration, so they leave with the audio in front of them. Everything
   * else advances `sentUntilMs` by its own length, and once that is far enough ahead of
   * now the rest waits for a timer rather than filling the socket.
   */
  private drain(): void {
    if (this.closed) return;
    const now = Date.now();
    if (this.sentUntilMs < now) this.sentUntilMs = now;

    while (this.outbound.length > 0 && this.sentUntilMs - now < CARRIER_LEAD_MS) {
      const next = this.outbound.shift();
      if (next === undefined) break;
      if (next.kind === "mark") {
        this.socket.send(encodeMark(this.streamSid, next.name));
        continue;
      }
      this.socket.send(encodeMedia(this.streamSid, next.data));
      this.sentUntilMs += audioMs(next.data.length, this.format);
    }

    if (this.draining !== null) return;
    if (this.outbound.length === 0) return;
    const wait = Math.max(20, this.sentUntilMs - now - CARRIER_LEAD_MS);
    this.draining = setTimeout(() => {
      this.draining = null;
      this.drain();
    }, wait);
    this.draining.unref?.();
  }

  onMark(listener: (name: string) => void): void {
    this.markListeners.push(listener);
  }

  clear(): void {
    if (this.closed) return;
    /* Anything still waiting here was never sent, so the carrier cannot be asked to drop
       it — it has to be dropped on this side. Leaving it queued would have the agent
       resume the sentence it was interrupted out of, a second later. */
    this.outbound.length = 0;
    this.sentUntilMs = 0;
    this.socket.send(encodeClear(this.streamSid));
  }

  onClosed(listener: (reason: string) => void): void {
    this.closedListeners.push(listener);
  }

  hangUp(): void {
    if (this.closed) return;
    // No TwiML verb follows <Connect>, so closing the socket ends the call.
    this.socket.close();
  }

  /** @internal Driven by the provider's frame loop. */
  emitAudio(chunk: AudioChunk): void {
    for (const listener of this.audioListeners) listener(chunk);
  }

  /** @internal */
  emitMark(name: string): void {
    for (const listener of this.markListeners) listener(name);
  }

  /** @internal Idempotent: the carrier's stop frame and the socket close both arrive. */
  onDigit(listener: (digit: string) => void): void {
    this.digitListeners.push(listener);
  }

  emitDigit(digit: string): void {
    for (const listener of this.digitListeners) listener(digit);
  }

  emitClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.outbound.length = 0;
    if (this.draining !== null) clearTimeout(this.draining);
    this.draining = null;
    for (const listener of this.closedListeners) listener(reason);
  }
}
