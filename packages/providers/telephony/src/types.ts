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
  /**
   * Where the carrier should report whether a human or a machine answered.
   *
   * Detection runs in parallel with the conversation rather than in front of it, so this
   * arrives after the agent has already started speaking. That is the right trade: the
   * alternative costs every human caller seven seconds of silence.
   */
  readonly amdCallbackUrl?: string;
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

/**
 * Where a call got to.
 *
 * The four terminal values that are not "completed" are the whole reason this exists:
 * they happen with no media stream, so without them a call that rang out is
 * indistinguishable from one that was never placed.
 */
export type CallOutcome =
  | "initiated"
  | "ringing"
  | "in-progress"
  | "completed"
  | "busy"
  | "no-answer"
  | "failed"
  | "canceled";

export interface CallStatusEvent {
  readonly callId: CallId;
  readonly status: CallOutcome;
  readonly direction: CallDirection;
  /** Billable seconds, present once the call is over. */
  readonly durationSeconds: number | null;
  /** Set when the carrier explains a failure. 486 is busy, 480 unavailable. */
  readonly sipCode: number | null;
}

/**
 * Whether the call ever reached a person.
 *
 * "completed" alone is not enough: a call that rings out and one that was answered and
 * hung up both end, and only one of them is worth retrying.
 */
export const wasAnswered = (event: CallStatusEvent): boolean =>
  event.status === "in-progress" ||
  (event.status === "completed" && (event.durationSeconds ?? 0) > 0);

/**
 * Handing a call in progress to a person.
 *
 * The agent has been talking to this caller for a while. Everything it learned is in the
 * event log, and none of it reaches the person answering unless it is spoken to them —
 * which is what `whisperUrl` is for. A transfer without it connects two people who have
 * to start over, which R6.4 exists to prevent.
 */
export interface TransferRequest {
  readonly callId: CallId;
  /** E.164. The person. */
  readonly to: string;
  /**
   * Caller ID shown to the person answering. Must be a number the carrier account owns —
   * presenting the caller's own number is rejected, and would hide who is transferring.
   */
  readonly from: string;
  /**
   * Fetched by the carrier when the person picks up and played to them ALONE, before the
   * two legs are joined. This is the handoff summary. The caller hears none of it.
   *
   * Absent means a cold transfer: honest, but the person starts from nothing.
   */
  readonly whisperUrl?: string;
  /** How long to ring before giving up. Past this the fallback below is spoken. */
  readonly ringSeconds?: number;
  /**
   * Said to the caller if nobody answers.
   *
   * Required in spirit rather than by the type only because a transfer that rings out
   * with no next verb hangs up on a caller who has already been failed once. Already
   * normalized by the time it reaches here — nothing unnormalized goes to any TTS,
   * including the carrier's.
   */
  readonly noAnswerLine?: string;
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
  /** Hang up a call in progress. Used when the thing that answered was a voicemail. */
  endCall(callId: CallId): Promise<void>;
  /**
   * Say one short thing to an answering machine and hang up.
   *
   * Separate from `endCall` because the difference is what the person finds later: a
   * silent hangup leaves a missed call from an unknown number and tells them nothing,
   * which serves neither them nor the business. Ten words that identify who rang and how
   * to call back is the whole of it.
   *
   * The caller is responsible for what goes in `message`, and the rule there is absolute:
   * never an amount, a balance, an account detail, or anything else somebody else in the
   * room should not hear.
   */
  leaveVoicemail(callId: CallId, message: string): Promise<void>;
  /**
   * Hand a call in progress to a person.
   *
   * Rejects rather than resolving on a carrier refusal. The caller is still on our media
   * stream at that point, so the escalation path can apologise out loud — which it could
   * not do if this swallowed the failure and reported a transfer that never happened.
   */
  transferToNumber(request: TransferRequest): Promise<void>;
  /**
   * The instruction to speak one line and nothing else.
   *
   * Serves `TransferRequest.whisperUrl`. It lives behind the adapter because the summary
   * is ours and the markup is the carrier's, and mixing the two would put TwiML in
   * orchestration code.
   */
  renderWhisper(line: string): CarrierResponse;
  /**
   * Read a call lifecycle callback. Null when the payload is not one, rather than
   * throwing: a carrier that adds a field must not take the process down.
   */
  parseCallStatus(payload: unknown): CallStatusEvent | null;
  /** Adopt a media socket the carrier has just opened. */
  attachMediaStream(socket: MediaSocket, handlers: MediaStreamHandlers): void;
}

/**
 * A number as the carrier account holds it, and where that carrier will send a call to it.
 *
 * Only the routing is here. Nothing about billing, capabilities or the number's friendly
 * name, because the one question this answers is "does this number point at us" — the
 * step of onboarding that nothing in this repository has ever checked, and the one whose
 * omission looks exactly like a correctly provisioned tenant right up until the phone
 * rings nowhere.
 */
export interface CarrierNumber {
  /** E.164, as the carrier spells it. */
  readonly number: string;
  /** Where an inbound call is announced. Null when the carrier holds the number and no URL. */
  readonly voiceUrl: string | null;
  readonly voiceMethod: string | null;
}

/**
 * Reading the carrier's own record of a number.
 *
 * Separate from `TelephonyProvider` rather than another method on it, for two reasons.
 * It is answerable by an account that can do nothing else — a read-only REST credential —
 * and it is the only part of the carrier surface a dashboard needs, so a deployment that
 * serves the dashboard and not the phone can hold one without the other. Fusing them
 * would also mean every test fake of the call path grew a method it never calls.
 */
export interface CarrierNumberDirectory {
  readonly name: string;
  /**
   * The carrier's record for one number, or null when the account does not hold it.
   *
   * Null is the ordinary answer for a Nigerian number: no carrier this platform has an
   * account with sells them, so the number belongs to the organisation's own carrier and
   * is invisible from here. It is not an error and must not be reported as one.
   *
   * Rejects rather than resolving when the carrier could not be reached or refused the
   * credential, because "we could not look" and "it is not there" are different answers
   * and collapsing them would let an expired API key read as a correctly wired number.
   */
  describeNumber(number: string): Promise<CarrierNumber | null>;
}
