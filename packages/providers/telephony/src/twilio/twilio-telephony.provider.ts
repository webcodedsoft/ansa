import { Buffer } from "node:buffer";
import { validateRequest } from "twilio";

import { asCallId } from "@ansa/shared";
import type { CallId } from "@ansa/shared";

import type {
  CallOutcome,
  CallStatusEvent,
  AnswerInstruction,
  CarrierResponse,
  InboundCall,
  MediaSocket,
  MediaStreamHandlers,
  TelephonyProvider,
  WebhookRequest,
  PlaceCallRequest,
  PlacedCall,
} from "../types";
import {
  parseFrame,
  parseStatusCallback,
  renderConnectStream,
  toAudioEncoding,
} from "./protocol";
import { TwilioMediaStream } from "./twilio-media-stream";

export interface TwilioProviderOptions {
  readonly authToken: string;
  /**
   * Off only for local testing without a carrier. Leaving this false in front of a
   * public tunnel lets anyone on the internet originate calls against this service.
   */
  readonly verifySignatures: boolean;
  /**
   * Account SID (AC…). Required only to place calls — an inbound-only deployment needs
   * no REST credentials at all, and demanding them would be a new failure mode for a
   * capability it never uses.
   */
  readonly accountSid?: string;
  /** Overridden in tests. */
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Places the call with the TwiML inlined rather than pointing the carrier at a webhook.
 *
 * Two reasons. It removes a round trip on answer, which is latency the caller hears as
 * dead air. And a webhook URL would have to carry the tenant, which means an enumerable
 * identifier in a query string that anyone who can reach the tunnel could probe; inlined,
 * the tenant travels inside the instruction and comes back only on the media socket.
 */
const buildCallForm = (
  request: PlaceCallRequest,
  streamXml: string,
): URLSearchParams => {
  const form = new URLSearchParams();
  form.set("To", request.to);
  form.set("From", request.from);
  form.set("Twiml", streamXml);

  // Defaults on, and asynchronous.
  //
  // Synchronous detection withholds the media stream until it has decided, which was
  // measured at 6.9 seconds of dead air before the first audio frame of an outbound
  // call — the caller says hello into nothing. Asynchronous connects immediately and
  // reports the verdict to a callback, so the conversation starts on time and voicemail
  // is still caught.
  //
  // DetectMessageEnd rather than Enable: knowing a machine answered is not useful on its
  // own, we need to know when its greeting has finished.
  if (request.detectVoicemail !== false) {
    form.set("MachineDetection", "DetectMessageEnd");
    form.set("AsyncAmd", "true");
    if (request.amdCallbackUrl !== undefined) {
      form.set("AsyncAmdStatusCallback", request.amdCallbackUrl);
      form.set("AsyncAmdStatusCallbackMethod", "POST");
    }
  }

  if (request.statusCallbackUrl !== undefined) {
    form.set("StatusCallback", request.statusCallbackUrl);
    // Ringing and no-answer are the events that distinguish outbound from inbound; the
    // default callback set omits them.
    for (const event of ["initiated", "ringing", "answered", "completed"]) {
      form.append("StatusCallbackEvent", event);
    }
  }

  return form;
};

export const createTwilioTelephonyProvider = (
  options: TwilioProviderOptions,
): TelephonyProvider => ({
  name: "twilio",

  verifyWebhook: (request: WebhookRequest): boolean => {
    if (!options.verifySignatures) return true;
    if (request.signature === null) return false;
    if (!isRecord(request.params)) return false;
    return validateRequest(
      options.authToken,
      request.signature,
      request.url,
      request.params as Record<string, string>,
    );
  },

  parseInboundCall: (payload: unknown): InboundCall => {
    if (!isRecord(payload)) {
      throw new Error("Inbound call webhook body was not an object");
    }
    const callSid = readString(payload["CallSid"]);
    const dialled = readString(payload["To"]);
    if (callSid === null || dialled === null) {
      throw new Error("Inbound call webhook body is missing CallSid or To");
    }
    return {
      callId: asCallId(callSid),
      dialled,
      // Withheld numbers arrive as "anonymous" rather than as an absent field.
      caller: readString(payload["From"]),
    };
  },

  renderAnswer: (instruction: AnswerInstruction): CarrierResponse => ({
    contentType: "text/xml; charset=utf-8",
    body: renderConnectStream(instruction.mediaStreamUrl, instruction.parameters ?? {}),
  }),

  endCall: async (callId: CallId): Promise<void> => {
    const accountSid = options.accountSid;
    if (accountSid === undefined || accountSid === "") {
      throw new Error("Cannot end a call without a Twilio account SID");
    }
    const doFetch = options.fetch ?? globalThis.fetch;
    const base = options.apiBaseUrl ?? "https://api.twilio.com";
    const response = await doFetch(
      `${base}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(callId)}.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${options.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ Status: "completed" }).toString(),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Could not end call ${callId} (${response.status}): ${detail.slice(0, 200)}`);
    }
  },

  parseCallStatus: (payload: unknown): CallStatusEvent | null => {
    const parsed = parseStatusCallback(payload);
    if (parsed === null) return null;
    return {
      callId: asCallId(parsed.callSid),
      status: parsed.status as CallOutcome,
      direction: parsed.outbound ? "outbound" : "inbound",
      durationSeconds: parsed.durationSeconds,
      sipCode: parsed.sipCode,
    };
  },

  placeCall: async (request: PlaceCallRequest): Promise<PlacedCall> => {
    const accountSid = options.accountSid;
    if (accountSid === undefined || accountSid === "") {
      throw new Error("Cannot place a call without a Twilio account SID");
    }

    const doFetch = options.fetch ?? globalThis.fetch;
    const base = options.apiBaseUrl ?? "https://api.twilio.com";
    const url = `${base}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`;

    const streamXml = renderConnectStream(request.mediaStreamUrl, request.parameters ?? {});
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        // Basic with the account SID as the username, which is what the REST API expects.
        Authorization: `Basic ${Buffer.from(`${accountSid}:${options.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: buildCallForm(request, streamXml).toString(),
    });

    if (!response.ok) {
      // Surfaced rather than swallowed: an unowned "from" number and a malformed
      // destination both land here, and both are configuration errors that are far
      // cheaper to read now than to infer from a call that never rings.
      const detail = await response.text().catch(() => "");
      throw new Error(`Carrier refused the call (${response.status}): ${detail.slice(0, 300)}`);
    }

    const body = (await response.json()) as { sid?: unknown; status?: unknown };
    if (typeof body.sid !== "string") {
      throw new Error("Carrier accepted the call but returned no call identifier");
    }

    return {
      callId: asCallId(body.sid),
      // Queued or initiated. It has not rung yet, let alone been answered.
      status: typeof body.status === "string" ? body.status : "unknown",
    };
  },

  attachMediaStream: (socket: MediaSocket, handlers: MediaStreamHandlers): void => {
    let stream: TwilioMediaStream | null = null;

    socket.onMessage((raw) => {
      const frame = parseFrame(raw);
      if (frame === null) return;

      switch (frame.event) {
        case "start": {
          if (stream !== null) return;
          const encoding = toAudioEncoding(frame.encoding);
          if (encoding === null) {
            handlers.onError(
              new Error(`Carrier opened a stream in an unsupported encoding: ${frame.encoding}`),
            );
            socket.close();
            return;
          }
          stream = new TwilioMediaStream(
            socket,
            frame.streamSid,
            frame.callSid,
            { encoding, sampleRate: frame.sampleRate },
            frame.parameters,
          );
          handlers.onStream(stream);
          return;
        }

        case "media":
          stream?.emitAudio({ data: frame.payload, offsetMs: frame.offsetMs });
          return;

        case "mark":
          stream?.emitMark(frame.name);
          return;

        case "stop":
          stream?.emitClosed("carrier sent stop");
          return;

        case "dtmf":
          stream?.emitDigit(frame.digit);
          return;

        case "connected":
          return;
      }
    });

    socket.onClose((reason) => {
      stream?.emitClosed(reason);
    });
  },
});
