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

/**
 * Whether a voice id is one this account can actually speak with.
 *
 * Exists because of a failure recorded in `docs/ONBOARDING_RUNBOOK.md`: a wrong voice id
 * publishes happily, and the first call synthesises nothing, retries once and hangs up.
 * That is the correct behaviour on a call — an open silent line is worse — but it is
 * discovered by a caller, which is the part worth fixing. One request answers it first.
 *
 * Separate from `TtsProvider` on purpose. Synthesis is on the latency path and is wanted
 * by the call process; this is a configuration question wanted by the dashboard, and a
 * deployment can hold credentials for one and not the other. Every test double of the
 * call path would also have grown a method it never calls.
 */
export interface VoiceCatalogue {
  readonly name: string;
  /**
   * Rejects rather than resolving false when the account could not be read. "This voice
   * does not exist" and "we could not ask" must not be the same answer: the first is a
   * configuration error the organisation has to fix, the second is ours.
   */
  knows(voiceId: string): Promise<boolean>;
}
