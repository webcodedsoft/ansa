import { Buffer } from "node:buffer";

import type { DeepgramSocket } from "@ansa/deepgram-listen";
import WebSocketClient, { type RawData } from "ws";

/**
 * Opens a Deepgram Flux socket and presents it as the narrow transport the adapter
 * consumes. Sibling of ws-listen-socket.ts, and deliberately separate rather than
 * parameterised: the two vendors differ in the two places that matter.
 *
 *  - Deepgram authenticates with `Token`, not `Bearer`. Bearer returns 401, verified.
 *    Copying the OpenAI file and keeping its keyword is the likeliest way to lose an hour.
 *  - Audio goes as raw binary frames, not base64 inside JSON.
 */
export const openDeepgramSocket = (url: string, apiKey: string): DeepgramSocket => {
  const socket = new WebSocketClient(url, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  // Registered before anything else: an unhandled 'error' event throws and kills the
  // process, taking every concurrent call with it.
  let failure: string | null = null;
  socket.on("error", (error: Error) => {
    failure = error.message;
  });

  return {
    onOpen: (listener) => {
      socket.on("open", listener);
    },
    onMessage: (listener) => {
      socket.on("message", (data: RawData) => {
        listener(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
      });
    },
    onClose: (listener) => {
      socket.on("close", (code: number) =>
        listener(failure ?? `deepgram socket closed with code ${code}`),
      );
    },
    onError: (listener) => {
      socket.on("error", listener);
    },
    send: (data) => {
      // Binary frame. ws sends a Buffer as binary by default, which is what Flux wants:
      // mu-law bytes unwrapped, no base64, no envelope.
      if (socket.readyState === WebSocketClient.OPEN) socket.send(data);
    },
    close: () => {
      socket.close();
    },
  };
};
