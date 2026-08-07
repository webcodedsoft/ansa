import type { AudioChunk, AudioFormat } from "@ansa/shared";

export interface SynthesisRequest {
  readonly text: string;
  readonly voiceId: string;
  /**
   * Requested output format. A provider that cannot emit telephony audio natively
   * forces a transcoding hop, which R4.2.4 treats as a cost against it.
   */
  readonly format: AudioFormat;
}

export interface SynthesisStream {
  onAudio(listener: (chunk: AudioChunk) => void): void;
  onDone(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
  /**
   * Barge-in. Stops synthesis and guarantees no further onAudio call. Without this
   * the agent keeps talking over a caller who has already interrupted (R6.1).
   */
  cancel(): void;
}

export interface TtsProvider {
  readonly name: string;
  /** Must stream. Non-streaming synthesis is disqualifying, not merely slow (R4.2.3). */
  synthesize(request: SynthesisRequest): SynthesisStream;
}
