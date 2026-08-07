export type AudioEncoding = "mulaw" | "linear16";

export interface AudioFormat {
  readonly encoding: AudioEncoding;
  readonly sampleRate: number;
}

/**
 * What the carrier sends and expects back. Any transcoding hop away from this is a
 * cost worth seeing rather than absorbing (R4.2.4).
 */
export const TELEPHONY_AUDIO: AudioFormat = {
  encoding: "mulaw",
  sampleRate: 8000,
};

export interface AudioChunk {
  readonly data: Buffer;
  /**
   * Milliseconds since this call's media stream opened. The orchestrator correlates
   * transcripts against turn events on this offset, never on arrival order, because
   * the two may come from different providers on different connections (R4.1.7).
   */
  readonly offsetMs: number;
}
