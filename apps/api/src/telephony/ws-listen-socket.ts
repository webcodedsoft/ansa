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
      socket.on("close", (code: number) => listener(`listen socket closed with code ${code}`));
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
