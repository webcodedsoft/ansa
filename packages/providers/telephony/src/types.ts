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

/**
 * Which way the call went.
 *
 * Present because the two lifecycles genuinely differ — an inbound call is answered by
 * definition, an outbound one can ring out, hit voicemail, or be rejected before any
 * audio exists. Not licence to enumerate further call kinds nobody has asked for.
 */
export type CallDirection = "inbound" | "outbound";

/** A call we are asking the carrier to place. */
export interface PlaceCallRequest {
  /** E.164. */
  readonly to: string;
  /** E.164, and must be a number the carrier account actually owns. */
  readonly from: string;
  readonly mediaStreamUrl: string;
  /**
   * Handed back to us on the media socket. Outbound already knows its tenant — it is the
   * one that asked for the call — so the tenant travels out here rather than being
   * resolved a second time from the caller ID.
   */
  readonly parameters?: Readonly<Record<string, string>>;
  /**
   * Ask the carrier to detect voicemail before connecting audio.
   *
   * An agent that holds a two-minute conversation with a voicemail greeting is both
   * useless and billed, so this defaults on and is turned off deliberately or not at all.
   */
  readonly detectVoicemail?: boolean;
  /** Where the carrier should report ringing, answer, no-answer and failure. */
  readonly statusCallbackUrl?: string;
}

/**
 * The carrier accepted the request. It has not rung yet, let alone been answered — the
 * orchestrator must not be started off the back of this.
 */
export interface PlacedCall {
  readonly callId: CallId;
  /** The carrier's own word for it: queued, initiated, ringing. */
  readonly status: string;
}

/** Where the carrier should open the bidirectional media socket for this call. */
export interface AnswerInstruction {
  readonly mediaStreamUrl: string;
  /**
   * Values to hand back to us when the carrier opens the media socket.
   *
   * The media socket carries no dialled number, so anything resolved at ingress — the
   * tenant, above all (R7.3) — has to travel with the answer or be resolved twice.
   */
  readonly parameters?: Readonly<Record<string, string>>;
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
  /** Whatever `AnswerInstruction.parameters` set, echoed back by the carrier. */
  readonly parameters: Readonly<Record<string, string>>;
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
  /**
   * Keypad tones. The carrier already sends these; they were being dropped at the
   * adapter. They are the fallback when speech capture has failed twice (R4.3.3).
   */
  onDigit(listener: (digit: string) => void): void;
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
  /**
   * Place an outbound call.
   *
   * Rejects rather than resolving on a carrier refusal — an unowned "from" number or a
   * malformed destination is a configuration error, and returning a half-call would push
   * the discovery downstream to somewhere with less context.
   */
  placeCall(request: PlaceCallRequest): Promise<PlacedCall>;
  /** Adopt a media socket the carrier has just opened. */
  attachMediaStream(socket: MediaSocket, handlers: MediaStreamHandlers): void;
}
