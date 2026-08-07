import type { AudioChunk, AudioFormat } from "@ansa/shared";

/**
 * Audio in, text out. Knows nothing about turns — when the caller stopped talking is
 * a different problem with a different best provider (see @ansa/turn-detector).
 */
export interface Word {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  /**
   * 0..1. Carried through to the orchestrator so a low-confidence turn can trigger a
   * clarifying question instead of a confident wrong answer (R4.1.5).
   */
  readonly confidence: number;
}

export interface Transcript {
  readonly text: string;
  readonly words: readonly Word[];
  readonly confidence: number;
  /** Milliseconds since the media stream opened. */
  readonly offsetMs: number;
}

export interface TranscriberOptions {
  readonly format: AudioFormat;
  /**
   * Per-tenant vocabulary boosting: Nigerian names, place names, insurer and bank
   * names (R4.1.3). "Ansa" is in the default set — callers say the brand back.
   */
  readonly keyterms: readonly string[];
}

export interface TranscriberSession {
  write(chunk: AudioChunk): void;
  onInterim(listener: (transcript: Transcript) => void): void;
  onFinal(listener: (transcript: Transcript) => void): void;
  close(): void;
}

export interface Transcriber {
  readonly name: string;
  /** Streaming with interim results. Batch STT is disqualifying (R4.1.4). */
  connect(options: TranscriberOptions): Promise<TranscriberSession>;
}
