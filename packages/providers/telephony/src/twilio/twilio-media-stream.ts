import type { AudioChunk, AudioFormat, CallId } from "@ansa/shared";
import { asCallId } from "@ansa/shared";

import type { CallMediaStream, MediaSocket } from "../types";
import { encodeClear, encodeMark, encodeMedia } from "./protocol";

export class TwilioMediaStream implements CallMediaStream {
  readonly callId: CallId;
  readonly format: AudioFormat;
  readonly parameters: Readonly<Record<string, string>>;

  private readonly socket: MediaSocket;
  private readonly streamSid: string;
  private readonly audioListeners: ((chunk: AudioChunk) => void)[] = [];
  private readonly markListeners: ((name: string) => void)[] = [];
  private readonly digitListeners: ((digit: string) => void)[] = [];
  private readonly closedListeners: ((reason: string) => void)[] = [];
  private closed = false;

  constructor(
    socket: MediaSocket,
    streamSid: string,
    callSid: string,
    format: AudioFormat,
    parameters: Readonly<Record<string, string>> = {},
  ) {
    this.socket = socket;
    this.streamSid = streamSid;
    this.callId = asCallId(callSid);
    this.format = format;
    this.parameters = parameters;
  }

  onAudio(listener: (chunk: AudioChunk) => void): void {
    this.audioListeners.push(listener);
  }

  send(chunk: AudioChunk): void {
    if (this.closed) return;
    this.socket.send(encodeMedia(this.streamSid, chunk.data));
  }

  mark(name: string): void {
    if (this.closed) return;
    this.socket.send(encodeMark(this.streamSid, name));
  }

  onMark(listener: (name: string) => void): void {
    this.markListeners.push(listener);
  }

  clear(): void {
    if (this.closed) return;
    this.socket.send(encodeClear(this.streamSid));
  }

  onClosed(listener: (reason: string) => void): void {
    this.closedListeners.push(listener);
  }

  hangUp(): void {
    if (this.closed) return;
    // No TwiML verb follows <Connect>, so closing the socket ends the call.
    this.socket.close();
  }

  /** @internal Driven by the provider's frame loop. */
  emitAudio(chunk: AudioChunk): void {
    for (const listener of this.audioListeners) listener(chunk);
  }

  /** @internal */
  emitMark(name: string): void {
    for (const listener of this.markListeners) listener(name);
  }

  /** @internal Idempotent: the carrier's stop frame and the socket close both arrive. */
  onDigit(listener: (digit: string) => void): void {
    this.digitListeners.push(listener);
  }

  emitDigit(digit: string): void {
    for (const listener of this.digitListeners) listener(digit);
  }

  emitClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closedListeners) listener(reason);
  }
}
