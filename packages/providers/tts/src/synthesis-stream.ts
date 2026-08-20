import type { AudioChunk } from "@ansa/shared";

import type { SynthesisStream } from "./types";

/**
 * The lifecycle every TTS adapter shares, in one place.
 *
 * Extracted when the second provider landed, and the reason is the A/B rather than tidiness.
 * Two adapters being compared on real calls must not differ in *how they stop* — if one
 * settles before emitting and the other after, or one keeps firing `onAudio` past a cancel,
 * the measurement is partly of the adapters and the comparison is worthless. One
 * implementation makes that impossible rather than merely unlikely.
 *
 * Three properties it guarantees, each of which is a live-call failure if it slips:
 *
 * - **Settled once.** `done` and `error` are terminal and mutually exclusive. A vendor that
 *   sends an error frame after its last audio must not produce both.
 * - **Silent after cancel.** Barge-in means no further `onAudio`, ever (R6.1). The caller is
 *   already talking; one more chunk is the agent talking over them.
 * - **The abort reaches the wire.** `signal` goes on the request, so cancelling stops the
 *   vendor generating audio nobody will hear — and stops the bill for it.
 *
 * Deliberately a class. The listener arrays and the settled flag are state with invariants
 * between them, and `func-style: expression` exempts methods for exactly this shape.
 */
export class VendorSynthesisStream implements SynthesisStream {
  private readonly audioListeners: ((chunk: AudioChunk) => void)[] = [];
  private readonly doneListeners: (() => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];
  private readonly controller = new AbortController();
  private cancelled = false;
  private settled = false;

  onAudio(listener: (chunk: AudioChunk) => void): void {
    this.audioListeners.push(listener);
  }

  onDone(listener: () => void): void {
    this.doneListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  cancel(): void {
    if (this.settled) return;
    this.cancelled = true;
    this.settled = true;
    // Aborts the in-flight request so the vendor stops billing for audio nobody hears.
    this.controller.abort();
  }

  /** Put on the request, so a barge-in tears the connection down rather than draining it. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  emitAudio(chunk: AudioChunk): void {
    if (this.settled) return;
    for (const listener of this.audioListeners) listener(chunk);
  }

  emitDone(): void {
    if (this.settled) return;
    this.settled = true;
    for (const listener of this.doneListeners) listener();
  }

  emitError(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    for (const listener of this.errorListeners) listener(error);
  }
}
