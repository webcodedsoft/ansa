import type { AudioChunk, AudioFormat } from "@ansa/shared";

/**
 * Audio in, turn events out. Knows nothing about words. Deliberately a separate
 * package from @ansa/transcriber even when one vendor serves both: the best
 * transcriber of Nigerian speech and the best end-of-turn detector are currently
 * not the same product, and fusing the interfaces forfeits that combination.
 */
export interface TurnEvent {
  /**
   * Milliseconds since the media stream opened. The orchestrator correlates this
   * against transcript offsets and must not assume the two share a connection
   * (R4.1.7).
   */
  readonly offsetMs: number;
}

export interface TurnDetectorOptions {
  readonly format: AudioFormat;
  readonly eotThreshold?: number;
  readonly eagerEotThreshold?: number;
}

export interface TurnSession {
  write(chunk: AudioChunk): void;
  /** Drives barge-in. Its latency bounds how fast the agent can stop talking. */
  onSpeechStart(listener: (event: TurnEvent) => void): void;
  /**
   * Speculative start, where the provider supports it. Only safe if onTurnResumed
   * genuinely cancels everything it set in motion (R4.1.8).
   */
  onEagerEndOfTurn(listener: (event: TurnEvent) => void): void;
  /** Commit the turn. */
  onEndOfTurn(listener: (event: TurnEvent) => void): void;
  /**
   * The caller was not finished. Must cancel all in-flight speculative work — LLM
   * request, tool dispatch, TTS synthesis. Speculation that cannot be retracted is
   * worse than no speculation.
   */
  onTurnResumed(listener: (event: TurnEvent) => void): void;
  close(): void;
}

export interface TurnDetector {
  readonly name: string;
  connect(options: TurnDetectorOptions): Promise<TurnSession>;
}
