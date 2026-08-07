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

/** An inbound webhook, as much of it as verifying the signature requires. */
export interface WebhookRequest {
  /** The absolute URL the carrier signed. Must match what the carrier called. */
  readonly url: string;
  readonly params: unknown;
  readonly signature: string | null;
}

/** The live audio leg of a call, in both directions. */
export interface CallMediaStream {
  readonly callId: CallId;
  readonly format: AudioFormat;
  /** Audio from the caller. */
  onAudio(listener: (chunk: AudioChunk) => void): void;
  /** Audio to the caller. */
  send(chunk: AudioChunk): void;
  /**
   * Place a marker after the audio queued so far. `onMark` fires when the caller has
   * actually heard up to that point. Queueing audio is not playing it, so this is the
   * only honest "finished speaking" signal — and hanging up without it truncates the
   * last words of the turn.
   */
  mark(name: string): void;
  onMark(listener: (name: string) => void): void;
  /** Discard audio already queued for playback. This is the barge-in primitive (R6.1). */
  clear(): void;
  onClosed(listener: (reason: string) => void): void;
  hangUp(): void;
}

export interface MediaStreamHandlers {
  /**
   * Fires when the carrier identifies which call this socket belongs to, which is a
   * frame or two after the socket opens, not at open time.
   */
  onStream(stream: CallMediaStream): void;
  onError(error: Error): void;
}

/**
 * A duplex text-frame transport. The HTTP server owns the real socket and hands the
 * adapter this narrow view, so `ws` never appears inside an adapter and carrier JSON
 * never appears inside the server.
 */
export interface MediaSocket {
  onMessage(listener: (data: string) => void): void;
  onClose(listener: (reason: string) => void): void;
  send(data: string): void;
  close(): void;
}

export interface TelephonyProvider {
  readonly name: string;
  /** Reject anything not genuinely signed by the carrier. */
  verifyWebhook(request: WebhookRequest): boolean;
  /** Turn a carrier's inbound-call webhook body into our own shape. */
  parseInboundCall(payload: unknown): InboundCall;
  /** Render the instruction to answer the call and start streaming media. */
  renderAnswer(instruction: AnswerInstruction): CarrierResponse;
  /** Adopt a media socket the carrier has just opened. */
  attachMediaStream(socket: MediaSocket, handlers: MediaStreamHandlers): void;
}
