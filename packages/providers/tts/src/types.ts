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
  /**
   * The voices worth putting in front of somebody choosing one.
   *
   * Rejects for the same reason `knows` does, and it is the same distinction: an empty
   * list means the account holds nothing, and a rejection means we could not ask. A
   * console that showed those the same way would tell an operator to go and buy voices
   * they already have.
   */
  list(): Promise<VoiceListing>;
}

/**
 * Whether the account can speak with a voice, as three ordered states rather than a
 * free/paid flag.
 *
 * "Free" is the wrong axis and answers the wrong question. What the console has to say is
 * whether picking this voice produces a working call *today*, and there are three honest
 * answers to that: it works now, it works once somebody adds it at the vendor, or this
 * plan cannot have it at all. Collapsing the last two into "paid" would let an operator
 * save an id that synthesises nothing, which is precisely the failure `knows` exists to
 * catch — one screen earlier.
 */
export type VoiceAvailability =
  /** On the account. Synthesis resolves it right now, so it is safe to save. */
  | "usable"
  /** In the public library and the plan allows it, but nobody has added it to the account. */
  | "addable"
  /** In the public library and this plan may not add it. Shown so the reason is visible. */
  | "beyond-plan";

/**
 * What a person navigates a list of voices by.
 *
 * Every field is nullable because every one of them is somebody else's metadata, entered
 * by whoever published the voice. A missing accent is a gap in the library, not an error,
 * and a list that refused to show a voice without one would hide working voices.
 */
export interface VoiceLabels {
  readonly accent: string | null;
  readonly gender: string | null;
  readonly age: string | null;
  readonly useCase: string | null;
  /** BCP-47-ish, as the vendor has it — `en`, sometimes `en-NG`. Displayed, never parsed. */
  readonly language: string | null;
}

export interface Voice {
  readonly voiceId: string;
  readonly name: string;
  /** The publisher's own sentence about the voice. Null when they wrote none. */
  readonly description: string | null;
  readonly availability: VoiceAvailability;
  /**
   * A clip of the voice speaking the publisher's own sample, fetchable without our
   * credentials. Null when there is none.
   *
   * Deliberately not "the agent's greeting in this voice": nothing here synthesises, and a
   * button that claimed to speak a line it had not synthesised would be a demonstration
   * rather than a preview. Whoever shows this has to say what it is.
   */
  readonly previewUrl: string | null;
  readonly labels: VoiceLabels;
}

export interface VoiceListing {
  readonly voices: readonly Voice[];
  /**
   * The public library did not answer, so `voices` holds only what is on the account.
   *
   * Separate from a rejection because the two failures are different sizes. Losing the
   * account read means we know nothing and must say so; losing the library means every
   * voice shown is still correct and still usable, and only the "what else could I have"
   * half is missing. Without this flag a short list reads as "this is all there is", which
   * is a different statement and a wrong one.
   */
  readonly libraryUnread: boolean;
}
