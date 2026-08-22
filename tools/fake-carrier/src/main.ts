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
  /**
   * How many calls to place at once. One by default, which is the debugging shape.
   *
   * Above one this stops being a debugger and becomes R5.5's load test: fifty concurrent
   * calls with the latency targets held. It is the same code either way rather than a second
   * harness, because a load test that speaks a different media protocol from the real one
   * measures the harness.
   */
  readonly calls: number;
}

const MODES: readonly Mode[] = ["unsigned", "signed", "badsig"];

const isMode = (value: string): value is Mode => (MODES as readonly string[]).includes(value);

const parseArgs = (argv: readonly string[]): Options => {
  let baseUrl = "http://127.0.0.1:3222";
  let mode: Mode = "unsigned";
  let frames = 120;
  let holdMs = 1000;
  let calls = 1;

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
      case "--calls": {
        const parsedCalls = Number(value);
        if (!Number.isInteger(parsedCalls) || parsedCalls < 1) {
          throw new Error("--calls must be >= 1");
        }
        calls = parsedCalls;
        i += 1;
        break;
      }
      case "--hold-ms":
        holdMs = Number(value);
        if (!Number.isInteger(holdMs) || holdMs < 0) throw new Error("--hold-ms must be >= 0");
        i += 1;
        break;
      default:
        throw new Error(`Unknown flag: ${String(flag)}`);
    }
  }

  return { baseUrl, mode, frames, holdMs, calls };
};

/**
 * Synthetic throughout. The SIDs are the carrier's documented shapes; the numbers are reserved
 * test ranges, not anyone's line.
 *
 * Both ids take the call's index, and that is load-bearing rather than tidy. They were
 * constants, which is correct for one call and wrong the moment there are fifty: the API keys a
 * call on the carrier's own id, so fifty calls sharing `CAfaketestcall…0001` are one call
 * reported fifty times, and the run would measure nothing while looking like it worked.
 */
const callParams = (index: number): Readonly<Record<string, string>> => {
  const suffix = String(index + 1).padStart(4, "0");
  return {
    CallSid: `CAfaketestcall0000000000000000${suffix}`,
    AccountSid: "ACfaketestacct00000000000000000001",
    From: "+2348012345678",
    To: "+2348099999999",
    CallStatus: "ringing",
    Direction: "inbound",
  };
};

const streamSid = (index: number): string =>
  `MZfaketeststream000000000000${String(index + 1).padStart(4, "0")}`;

/** Stands in for the time the carrier takes to play queued audio before echoing a mark. */
const MARK_PLAYBACK_MS = 150;

const buildHeaders = (mode: Mode, url: string, params: Readonly<Record<string, string>>): Record<string, string> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (mode === "signed") {
    const token = process.env["TWILIO_AUTH_TOKEN"] ?? "";
    if (token.length === 0) {
      throw new Error("--mode signed needs TWILIO_AUTH_TOKEN set to the API's token");
    }
    headers["X-Twilio-Signature"] = getExpectedTwilioSignature(token, url, { ...params });
  } else if (mode === "badsig") {
    headers["X-Twilio-Signature"] = "definitelynotavalidsignature==";
  }

  return headers;
};

interface OutboundTally {
  media: number;
  mediaBytes: number;
  marks: string[];
  clears: number;
}

const tallyOutbound = (
  raw: string,
  tally: OutboundTally,
  onMark: (name: string) => void,
): void => {
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
    if (typeof name === "string") onMark(name);
    return;
  }

  if (event === "clear") {
    tally.clears += 1;
    console.log("[carrier] <- clear (barge-in)");
  }
};

const streamMedia = async (
  streamUrl: string,
  options: Options,
  index: number,
): Promise<number> => {
  const sid = streamSid(index);
  const params = callParams(index);
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
    tallyOutbound(data.toString("utf8"), tally, (name) => {
      // The real carrier echoes a mark back once playback reaches it. Without this the
      // agent can never learn that the caller actually heard the audio.
      setTimeout(() => {
        socket.send(JSON.stringify({ event: "mark", streamSid: sid, mark: { name } }));
      }, MARK_PLAYBACK_MS);
    });
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
      streamSid: sid,
      start: {
        accountSid: params["AccountSid"],
        callSid: params["CallSid"],
        streamSid: sid,
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
        streamSid: sid,
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
    JSON.stringify({ event: "stop", sequenceNumber: "999", streamSid: sid, stop: {} }),
  );
  await delay(100);
  socket.close();

  return finished;
};

interface CallResult {
  readonly ok: boolean;
  /** How long the carrier waited for TwiML. The first thing a caller feels. */
  readonly answerMs: number;
}

/**
 * One call, end to end, quietly enough that fifty of them do not drown the summary.
 *
 * `verbose` is the difference between the debugging shape and the load shape. Below one call
 * the per-frame narration is the point; above it, fifty copies of it hide the only two numbers
 * anybody is reading.
 */
const placeCall = async (options: Options, index: number, verbose: boolean): Promise<CallResult> => {
  const url = `${options.baseUrl}/telephony/voice`;
  const params = callParams(index);
  const started = Date.now();

  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(options.mode, url, params),
    body: new URLSearchParams(params),
  });
  const body = await response.text();
  const answerMs = Date.now() - started;

  if (verbose) {
    console.log(`[carrier] POST ${url} (${options.mode}) -> ${response.status} in ${answerMs}ms`);
    console.log(`[carrier] content-type: ${response.headers.get("content-type") ?? "(none)"}`);
    console.log(`[carrier] body: ${body}`);
  }

  if (response.status === 403) {
    // The correct outcome for unsigned and badsig against an API that verifies.
    if (verbose) console.log("[carrier] rejected by signature verification");
    return { ok: true, answerMs };
  }
  if (response.status !== 200) {
    console.error(`[carrier] call ${index + 1}: expected 200 with TwiML, got ${response.status}`);
    return { ok: false, answerMs };
  }

  const streamUrl = /url="([^"]+)"/.exec(body)?.[1];
  if (streamUrl === undefined) {
    console.error(`[carrier] call ${index + 1}: answered 200 but the TwiML contains no stream url`);
    return { ok: false, answerMs };
  }

  if (verbose) console.log(`[carrier] opening media socket at ${streamUrl}`);
  const code = await streamMedia(streamUrl, options, index);
  return { ok: code === 0, answerMs };
};

/**
 * Nearest-rank, and percentiles rather than a mean, for the reason the rest of this codebase
 * reports percentiles: one slow call among fifty moves an average and hides the forty-nine.
 */
const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] ?? 0;
};

const main = async (): Promise<number> => {
  const options = parseArgs(process.argv.slice(2));
  const verbose = options.calls === 1;

  if (!verbose) {
    console.log(`[carrier] placing ${options.calls} calls at once against ${options.baseUrl}`);
  }

  /* All at once, deliberately. R5.5 asks whether the targets hold under fifty concurrent
     calls, and a ramp would answer a different and easier question. */
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: options.calls }, (_, index) => placeCall(options, index, verbose)),
  );
  const elapsed = Date.now() - started;

  if (verbose) return results[0]?.ok === true ? 0 : 1;

  const failed = results.filter((result) => !result.ok).length;
  const answers = results.map((result) => result.answerMs);

  console.log("");
  console.log(`[carrier] ${options.calls} calls in ${elapsed}ms, ${failed} failed`);
  console.log(
    `[carrier] time to TwiML: p50 ${percentile(answers, 0.5)}ms · ` +
      `p95 ${percentile(answers, 0.95)}ms · max ${Math.max(...answers)}ms`,
  );
  /* What this does and does not measure, said here rather than left to be assumed. The number
     above is the carrier's wait for an answer, which is the part this harness can see from
     outside. Turn-to-audio — the one the product is judged on — is measured inside the API and
     lands in `latencies`; read it there for the same run. */
  console.log("[carrier] turn-to-audio is measured server-side: query `latencies` for this run");

  return failed === 0 ? 0 : 1;
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[carrier] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
