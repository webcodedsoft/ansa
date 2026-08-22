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
  /** `<Parameter>` values from the TwiML, echoed back to us here. */
  readonly parameters: Readonly<Record<string, string>>;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const readNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Parse one inbound frame. Returns null for anything malformed or unrecognised: a
 * carrier adding a new event type must not take a call down.
 */
export const parseFrame = (raw: string): TwilioFrame | null => {
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
      // Twilio sends every custom parameter as a string; anything else is dropped
      // rather than coerced, because a half-parsed tenant id is worse than none.
      const raw = start["customParameters"];
      const parameters: Record<string, string> = {};
      if (isRecord(raw)) {
        for (const [key, value] of Object.entries(raw)) {
          const text = readString(value);
          if (text !== null) parameters[key] = text;
        }
      }
      return { event: "start", streamSid, callSid, encoding, sampleRate, parameters };
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
};

export const encodeMedia = (streamSid: string, payload: Buffer): string =>
  JSON.stringify({
    event: "media",
    streamSid,
    media: { payload: payload.toString("base64") },
  });

export const encodeMark = (streamSid: string, name: string): string =>
  JSON.stringify({ event: "mark", streamSid, mark: { name } });

export const encodeClear = (streamSid: string): string =>
  JSON.stringify({ event: "clear", streamSid });

export const toAudioEncoding = (carrierEncoding: string): AudioEncoding | null => {
  if (carrierEncoding === "audio/x-mulaw") return "mulaw";
  if (carrierEncoding === "audio/l16") return "linear16";
  return null;
};

const XML_ESCAPES: Readonly<Record<string, string>> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "'": "&apos;",
  '"': "&quot;",
};

export const escapeXml = (value: string): string =>
  value.replace(/[<>&'"]/g, (char) => XML_ESCAPES[char] ?? char);

/**
 * `<Connect><Stream>` is the bidirectional verb. `<Start><Stream>` only forks audio to
 * us and cannot play anything back, which would make Slice 1 step 4 impossible.
 *
 * The document deliberately ends after `</Connect>`: when the socket closes there is no
 * next verb, so the carrier hangs up. That is how hangUp() works without REST credentials.
 */
export const renderConnectStream = (
  mediaStreamUrl: string,
  parameters: Readonly<Record<string, string>> = {},
): string => {
  const params = Object.entries(parameters)
    .map(([name, value]) => `<Parameter name="${escapeXml(name)}" value="${escapeXml(value)}" />`)
    .join("");
  const stream =
    params === ""
      ? `<Stream url="${escapeXml(mediaStreamUrl)}" />`
      : `<Stream url="${escapeXml(mediaStreamUrl)}">${params}</Stream>`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' + `<Response><Connect>${stream}</Connect></Response>`
  );
};

/**
 * Replaces a live call's instruction with a dial to a person.
 *
 * Three details are load-bearing and each was chosen against a specific failure:
 *
 * `answerOnBridge` — without it the carrier treats the caller's leg as connected the
 * instant the dial starts, and the caller hears nothing at all while the human's phone
 * rings. Silence over two seconds reads as a dropped call (R6.2), and a caller who has
 * just been told "let me get a colleague" is exactly the caller who will hang up.
 *
 * `url` on the number — TwiML fetched when the PERSON answers, played to them alone
 * before the legs are joined. This is the whole handoff: without it the human picks up
 * to a stranger mid-sentence and asks for the name the caller spent four minutes
 * spelling.
 *
 * A verb AFTER `</Dial>` — a document that ends at the dial hangs up on the caller when
 * nobody answers. They have already been failed once; being cut off is the second time.
 */
/**
 * One short message onto an answering machine, then hang up.
 *
 * Replacing the live call's instruction ends our media stream, which is exactly what is
 * wanted here — the agent must stop talking to a machine the moment we know it is one, and
 * the alternative is a two-minute conversation with a voicemail greeting that is both
 * useless and billed.
 *
 * `<Say>` rather than the agent's own voice. Playing the cloned voice would mean a
 * publicly fetchable audio URL for every message, and the carrier's voice on ten words
 * left on an answerphone is a smaller cost than a public endpoint serving synthesised
 * speech. It is worth knowing the trade was made rather than overlooked.
 *
 * Nothing private may be composed into `message` — see the caller. Someone else in the
 * room will hear this.
 */
export const renderVoicemail = (message: string): string =>
  `<Response><Say>${escapeXml(message)}</Say><Hangup /></Response>`;

export const renderDialTransfer = (options: {
  readonly to: string;
  readonly callerId: string;
  readonly whisperUrl?: string;
  readonly ringSeconds?: number;
  readonly noAnswerLine?: string;
}): string => {
  const number =
    options.whisperUrl === undefined
      ? `<Number>${escapeXml(options.to)}</Number>`
      : `<Number url="${escapeXml(options.whisperUrl)}">${escapeXml(options.to)}</Number>`;

  const timeout =
    options.ringSeconds === undefined ? "" : ` timeout="${Math.round(options.ringSeconds)}"`;

  const fallback =
    options.noAnswerLine === undefined
      ? ""
      : `<Say>${escapeXml(options.noAnswerLine)}</Say>`;

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<Response>" +
    `<Dial answerOnBridge="true" callerId="${escapeXml(options.callerId)}"${timeout}>${number}</Dial>` +
    fallback +
    "<Hangup />" +
    "</Response>"
  );
};

/**
 * One spoken line and nothing else, for the whisper the person answering hears.
 *
 * Deliberately has no `<Gather>` and no next verb: the carrier joins the two legs the
 * moment this document finishes, which is what makes the summary a preamble rather than
 * a menu the caller is left waiting behind.
 */
export const renderSay = (line: string): string =>
  '<?xml version="1.0" encoding="UTF-8"?>' + `<Response><Say>${escapeXml(line)}</Say></Response>`;

const OUTCOMES = new Set([
  "initiated", "ringing", "in-progress", "completed", "busy", "no-answer", "failed", "canceled",
]);

/**
 * Reads a Twilio call status callback.
 *
 * Twilio reports direction as "outbound-api" or "outbound-dial" depending on how the
 * call was created; both are outbound as far as anything above the adapter is concerned,
 * and leaking that distinction upward would be a vendor word in orchestration code.
 */
export const parseStatusCallback = (
  payload: unknown,
): {
  callSid: string;
  status: string;
  outbound: boolean;
  durationSeconds: number | null;
  sipCode: number | null;
} | null => {
  if (!isRecord(payload)) return null;

  const callSid = readString(payload["CallSid"]);
  const status = readString(payload["CallStatus"]);
  if (callSid === null || status === null || !OUTCOMES.has(status)) return null;

  // CallDuration on the completed callback, Duration elsewhere; absent while in flight.
  const rawDuration = readString(payload["CallDuration"]) ?? readString(payload["Duration"]);
  const duration = rawDuration === null ? null : Number.parseInt(rawDuration, 10);

  const rawSip = readString(payload["SipResponseCode"]);
  const sipCode = rawSip === null ? null : Number.parseInt(rawSip, 10);

  return {
    callSid,
    status,
    outbound: (readString(payload["Direction"]) ?? "inbound").startsWith("outbound"),
    durationSeconds: duration !== null && Number.isFinite(duration) ? duration : null,
    sipCode: sipCode !== null && Number.isFinite(sipCode) ? sipCode : null,
  };
};

