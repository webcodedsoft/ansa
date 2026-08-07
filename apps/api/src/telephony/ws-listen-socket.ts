import { Buffer } from "node:buffer";

import type { ListenSocket } from "@ansa/openai-listen";
import WebSocketClient, { type RawData } from "ws";

/**
 * Opens the realtime listen connection and presents it as the narrow transport the
 * adapter consumes. The only file in apps/api that knows this vendor's URL, exactly as
 * ws-media-socket.ts is the only one that knows the carrier's transport.
 */
export const openListenSocket = (apiKey: string): ListenSocket => {
  const socket = new WebSocketClient("wss://api.openai.com/v1/realtime?intent=transcription", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  // Registered immediately. An unhandled 'error' event throws and kills the process,
  // and a Lagos-to-US socket dropping is ordinary weather rather than an exceptional
  // event. The reason is carried into the close handler so the orchestrator can say
  // something to the caller instead of going quietly deaf.
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
        listener(failure ?? `listen socket closed with code ${code}`),
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
