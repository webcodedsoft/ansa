import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";

import { getExpectedTwilioSignature } from "twilio";
import { WebSocket } from "ws";

type Mode = "unsigned" | "signed" | "badsig";

interface Options {
  readonly baseUrl: string;
  readonly mode: Mode;
  readonly frames: number;
  readonly holdMs: number;
}

const MODES: readonly Mode[] = ["unsigned", "signed", "badsig"];

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value);
}

function parseArgs(argv: readonly string[]): Options {
  let baseUrl = "http://127.0.0.1:3222";
  let mode: Mode = "unsigned";
  let frames = 120;
  let holdMs = 1000;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${String(flag)}`);

    switch (flag) {
      case "--url":
        baseUrl = value.replace(/\/+$/, "");
        i += 1;
        break;
      case "--mode":
        if (!isMode(value)) throw new Error(`Unknown mode: ${value}. Use ${MODES.join(", ")}.`);
        mode = value;
        i += 1;
        break;
      case "--frames":
        frames = Number(value);
        if (!Number.isInteger(frames) || frames < 0) throw new Error("--frames must be >= 0");
        i += 1;
        break;
      case "--hold-ms":
        holdMs = Number(value);
        if (!Number.isInteger(holdMs) || holdMs < 0) throw new Error("--hold-ms must be >= 0");
        i += 1;
        break;
      default:
        throw new Error(`Unknown flag: ${String(flag)}`);
    }
  }

  return { baseUrl, mode, frames, holdMs };
}

// Synthetic throughout. The SIDs are the carrier's documented shapes; the numbers are
// reserved test ranges, not anyone's line.
const CALL_PARAMS: Readonly<Record<string, string>> = {
  CallSid: "CAfaketestcall00000000000000000001",
  AccountSid: "ACfaketestacct00000000000000000001",
  From: "+2348012345678",
  To: "+2348099999999",
  CallStatus: "ringing",
  Direction: "inbound",
};

const STREAM_SID = "MZfaketeststream0000000000000001";

function buildHeaders(mode: Mode, url: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (mode === "signed") {
    const token = process.env["TWILIO_AUTH_TOKEN"] ?? "";
    if (token.length === 0) {
      throw new Error("--mode signed needs TWILIO_AUTH_TOKEN set to the API's token");
    }
    headers["X-Twilio-Signature"] = getExpectedTwilioSignature(token, url, { ...CALL_PARAMS });
  } else if (mode === "badsig") {
    headers["X-Twilio-Signature"] = "definitelynotavalidsignature==";
  }

  return headers;
}

interface OutboundTally {
  media: number;
  mediaBytes: number;
  marks: string[];
  clears: number;
}

function tallyOutbound(raw: string, tally: OutboundTally): void {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    console.log(`[carrier] <- unparseable frame: ${raw.slice(0, 80)}`);
    return;
  }
  if (typeof frame !== "object" || frame === null) return;

  const record = frame as Record<string, unknown>;
  const event = record["event"];

  if (event === "media") {
    const media = record["media"];
    const payload =
      typeof media === "object" && media !== null
        ? (media as Record<string, unknown>)["payload"]
        : undefined;
    tally.media += 1;
    if (typeof payload === "string") {
      tally.mediaBytes += Buffer.from(payload, "base64").length;
    }
    return;
  }

  if (event === "mark") {
    const mark = record["mark"];
    const name =
      typeof mark === "object" && mark !== null
        ? (mark as Record<string, unknown>)["name"]
        : undefined;
    tally.marks.push(typeof name === "string" ? name : "(unnamed)");
    console.log(`[carrier] <- mark ${String(name)}`);
    return;
  }

  if (event === "clear") {
    tally.clears += 1;
    console.log("[carrier] <- clear (barge-in)");
  }
}

async function streamMedia(streamUrl: string, options: Options): Promise<number> {
  const socket = new WebSocket(streamUrl);
  const tally: OutboundTally = { media: 0, mediaBytes: 0, marks: [], clears: 0 };

  const finished = new Promise<number>((resolve) => {
    socket.on("close", () => {
      console.log(
        `[carrier] socket closed. received ${tally.media} media frames ` +
          `(${tally.mediaBytes} bytes), marks ${JSON.stringify(tally.marks)}, ` +
          `${tally.clears} clear(s)`,
      );
      resolve(0);
    });
    socket.on("error", (error: Error) => {
      console.error(`[carrier] socket error: ${error.message}`);
      resolve(1);
    });
  });

  socket.on("message", (data: Buffer) => {
    tallyOutbound(data.toString("utf8"), tally);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  socket.send(
    JSON.stringify({
      event: "start",
      sequenceNumber: "1",
      streamSid: STREAM_SID,
      start: {
        accountSid: CALL_PARAMS["AccountSid"],
        callSid: CALL_PARAMS["CallSid"],
        streamSid: STREAM_SID,
        tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      },
    }),
  );

  // 160 bytes is one 20ms frame of 8kHz mu-law, which is what the carrier actually sends.
  for (let i = 0; i < options.frames; i += 1) {
    socket.send(
      JSON.stringify({
        event: "media",
        sequenceNumber: String(i + 2),
        streamSid: STREAM_SID,
        media: {
          track: "inbound",
          chunk: String(i + 1),
          timestamp: String(i * 20),
          payload: Buffer.alloc(160, i % 256).toString("base64"),
        },
      }),
    );
    await delay(2);
  }
  console.log(`[carrier] sent ${options.frames} media frames (${options.frames * 160} bytes)`);

  // Hold the socket open so anything the agent plays back has time to arrive.
  await delay(options.holdMs);

  socket.send(
    JSON.stringify({ event: "stop", sequenceNumber: "999", streamSid: STREAM_SID, stop: {} }),
  );
  await delay(100);
  socket.close();

  return finished;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const url = `${options.baseUrl}/telephony/voice`;

  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(options.mode, url),
    body: new URLSearchParams(CALL_PARAMS),
  });
  const body = await response.text();

  console.log(`[carrier] POST ${url} (${options.mode}) -> ${response.status}`);
  console.log(`[carrier] content-type: ${response.headers.get("content-type") ?? "(none)"}`);
  console.log(`[carrier] body: ${body}`);

  if (response.status === 403) {
    // The correct outcome for unsigned and badsig against an API that verifies.
    console.log("[carrier] rejected by signature verification");
    return 0;
  }

  if (response.status !== 200) {
    console.error(`[carrier] expected 200 with TwiML, got ${response.status}`);
    return 1;
  }

  const streamUrl = /url="([^"]+)"/.exec(body)?.[1];
  if (streamUrl === undefined) {
    console.error("[carrier] answered 200 but the TwiML contains no stream url");
    return 1;
  }

  console.log(`[carrier] opening media socket at ${streamUrl}`);
  return streamMedia(streamUrl, options);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[carrier] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
