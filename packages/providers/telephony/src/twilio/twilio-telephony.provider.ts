import { validateRequest } from "twilio";

import { asCallId } from "@ansa/shared";

import type {
  AnswerInstruction,
  CarrierResponse,
  InboundCall,
  MediaSocket,
  MediaStreamHandlers,
  TelephonyProvider,
  WebhookRequest,
} from "../types";
import { parseFrame, renderConnectStream, toAudioEncoding } from "./protocol";
import { TwilioMediaStream } from "./twilio-media-stream";

export interface TwilioProviderOptions {
  readonly authToken: string;
  /**
   * Off only for local testing without a carrier. Leaving this false in front of a
   * public tunnel lets anyone on the internet originate calls against this service.
   */
  readonly verifySignatures: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

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
