import { Buffer } from "node:buffer";

import type { AudioEncoding } from "@ansa/shared";

/**
 * The Media Streams wire protocol, isolated from the rest of the adapter so it can be
 * tested without a socket. Everything here is pure: strings in, values out.
 */

export interface TwilioConnected {
  readonly event: "connected";
}

export interface TwilioStart {
  readonly event: "start";
  readonly streamSid: string;
  readonly callSid: string;
  readonly encoding: string;
  readonly sampleRate: number;
}

export interface TwilioMedia {
  readonly event: "media";
  readonly streamSid: string;
  readonly track: string;
  /** Milliseconds since the stream opened, as the carrier counts it. */
  readonly offsetMs: number;
  readonly payload: Buffer;
}

export interface TwilioMark {
  readonly event: "mark";
  readonly streamSid: string;
  readonly name: string;
}

export interface TwilioStop {
  readonly event: "stop";
  readonly streamSid: string;
}

export interface TwilioDtmf {
  readonly event: "dtmf";
  readonly streamSid: string;
  readonly digit: string;
}

export type TwilioFrame =
  | TwilioConnected
  | TwilioStart
  | TwilioMedia
  | TwilioMark
  | TwilioStop
  | TwilioDtmf;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Parse one inbound frame. Returns null for anything malformed or unrecognised: a
 * carrier adding a new event type must not take a call down.
 */
export function parseFrame(raw: string): TwilioFrame | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(decoded)) return null;

  const event = readString(decoded["event"]);
  if (event === null) return null;

  switch (event) {
    case "connected":
      return { event: "connected" };

    case "start": {
      const start = decoded["start"];
      if (!isRecord(start)) return null;
      const streamSid = readString(start["streamSid"]) ?? readString(decoded["streamSid"]);
      const callSid = readString(start["callSid"]);
      if (streamSid === null || callSid === null) return null;

      const mediaFormat = isRecord(start["mediaFormat"]) ? start["mediaFormat"] : {};
      const encoding = readString(mediaFormat["encoding"]) ?? "audio/x-mulaw";
      const sampleRate = readNumber(mediaFormat["sampleRate"]) ?? 8000;
      return { event: "start", streamSid, callSid, encoding, sampleRate };
    }

    case "media": {
      const media = decoded["media"];
      const streamSid = readString(decoded["streamSid"]);
      if (!isRecord(media) || streamSid === null) return null;
      const payload = readString(media["payload"]);
      if (payload === null) return null;
      return {
        event: "media",
        streamSid,
        track: readString(media["track"]) ?? "inbound",
        offsetMs: readNumber(media["timestamp"]) ?? 0,
        payload: Buffer.from(payload, "base64"),
      };
    }

    case "mark": {
      const mark = decoded["mark"];
      const streamSid = readString(decoded["streamSid"]);
      if (!isRecord(mark) || streamSid === null) return null;
      const name = readString(mark["name"]);
      if (name === null) return null;
      return { event: "mark", streamSid, name };
    }

    case "stop": {
      const streamSid = readString(decoded["streamSid"]);
      if (streamSid === null) return null;
      return { event: "stop", streamSid };
    }

    case "dtmf": {
      const dtmf = decoded["dtmf"];
      const streamSid = readString(decoded["streamSid"]);
      if (!isRecord(dtmf) || streamSid === null) return null;
      const digit = readString(dtmf["digit"]);
      if (digit === null) return null;
      return { event: "dtmf", streamSid, digit };
    }

    default:
      return null;
  }
}

export function encodeMedia(streamSid: string, payload: Buffer): string {
  return JSON.stringify({
    event: "media",
    streamSid,
    media: { payload: payload.toString("base64") },
  });
}

export function encodeMark(streamSid: string, name: string): string {
  return JSON.stringify({ event: "mark", streamSid, mark: { name } });
}

export function encodeClear(streamSid: string): string {
  return JSON.stringify({ event: "clear", streamSid });
}

export function toAudioEncoding(carrierEncoding: string): AudioEncoding | null {
  if (carrierEncoding === "audio/x-mulaw") return "mulaw";
  if (carrierEncoding === "audio/l16") return "linear16";
  return null;
}

const XML_ESCAPES: Readonly<Record<string, string>> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "'": "&apos;",
  '"': "&quot;",
};

export function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => XML_ESCAPES[char] ?? char);
}

/**
 * `<Connect><Stream>` is the bidirectional verb. `<Start><Stream>` only forks audio to
 * us and cannot play anything back, which would make Slice 1 step 4 impossible.
 *
 * The document deliberately ends after `</Connect>`: when the socket closes there is no
 * next verb, so the carrier hangs up. That is how hangUp() works without REST credentials.
 */
export function renderConnectStream(mediaStreamUrl: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Connect><Stream url="${escapeXml(mediaStreamUrl)}" /></Connect></Response>`
  );
}
