import { Buffer } from "node:buffer";

import type { IntronSocket } from "@ansa/intron-listen";
import WebSocketClient, { type RawData } from "ws";

/**
 * Opens an Intron streaming socket and presents it as the narrow transport the adapter
 * consumes. Sibling of ws-deepgram-socket.ts, separate for the same reason: the two
 * vendors differ exactly where a shared file would hide it.
 *
 *  - Intron authenticates with `Bearer`. Deepgram uses `Token` and returns 401 for Bearer,
 *    so copying that file and keeping its keyword is the likeliest way to lose an hour.
 *  - Everything goes as text. Audio is base64 inside a JSON envelope, never a binary frame.
 */
export const openIntronSocket = (url: string, apiKey: string): IntronSocket => {
  const socket = new WebSocketClient(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
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
        listener(failure ?? `intron socket closed with code ${code}`),
      );
    },
    onError: (listener) => {
      socket.on("error", listener);
    },
    send: (data) => {
      if (socket.readyState === WebSocketClient.OPEN) socket.send(data);
    },
    close: () => {
      socket.close();
    },
  };
};
