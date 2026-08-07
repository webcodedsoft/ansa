import { Buffer } from "node:buffer";

import type { MediaSocket } from "@ansa/telephony";
import type { RawData, WebSocket } from "ws";

function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/**
 * Wraps a `ws` socket in the narrow duplex view the telephony adapter consumes. This is
 * the only file in apps/api that knows the transport library, and the adapter on the
 * other side is the only code that knows the carrier's JSON.
 */
export function fromWebSocket(socket: WebSocket): MediaSocket {
  return {
    onMessage(listener) {
      socket.on("message", (data: RawData) => {
        listener(toText(data));
      });
    },
    onClose(listener) {
      socket.on("close", (code: number, reason: Buffer) => {
        const text = reason.toString("utf8");
        listener(text.length > 0 ? text : `socket closed with code ${code}`);
      });
    },
    send(data) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    },
    close() {
      socket.close();
    },
  };
}
