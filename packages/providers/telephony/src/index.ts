import type { AudioChunk, AudioFormat, CallId } from "@ansa/shared";

/**
 * An inbound call as the platform sees it. Carrier webhook payloads are parsed into
 * this shape by the adapter; no carrier type crosses this boundary.
 *
 * Ansa answers calls and does not place them, so there is no direction field here
 * and there should never be one.
 */
export interface InboundCall {
  readonly callId: CallId;
  /** The number the caller dialled. Slice 7 resolves the tenant from this (R7.3). */
  readonly dialled: string;
  /** The caller's number as the carrier reports it. May be withheld. */
  readonly caller: string | null;
}

/** Where the carrier should open the bidirectional media socket for this call. */
export interface AnswerInstruction {
  readonly mediaStreamUrl: string;
}

/**
 * A carrier response already serialized by the adapter into whatever that carrier
 * expects (TwiML, NCCO, ...). The HTTP layer writes it without inspecting it.
 */
export interface CarrierResponse {
  readonly contentType: string;
  readonly body: string;
}

/** The live audio leg of a call, in both directions. */
export interface CallMediaStream {
  readonly callId: CallId;
  readonly format: AudioFormat;
  /** Audio from the caller. */
  onAudio(listener: (chunk: AudioChunk) => void): void;
  /** Audio to the caller. */
  send(chunk: AudioChunk): void;
  onClosed(listener: (reason: string) => void): void;
  hangUp(): void;
}

export interface TelephonyProvider {
  readonly name: string;
  /** Turn a carrier's inbound-call webhook body into our own shape. */
  parseInboundCall(payload: unknown): InboundCall;
  /** Render the instruction to answer the call and start streaming media. */
  renderAnswer(instruction: AnswerInstruction): CarrierResponse;
  // Adopting the opened media socket lands in step 2, once the transport the
  // carrier actually uses is known. Guessing its signature now would be fiction.
}
