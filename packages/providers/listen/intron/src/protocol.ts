import type { AudioFormat } from "@ansa/shared";

/**
 * The Intron streaming wire, isolated so it can be tested without a socket.
 *
 * Read from docs.voice.intron.io on 2026-08-23. Two things this provider does not do, and
 * both are visible in the types rather than hidden: it reports no word-level confidence and
 * accepts no keyterms. `Transcript.confidence` is therefore null on every result, which the
 * transcriber interface documents as "not the same as low".
 */

/** Base64 PCM16 in JSON, so the floor and ceiling are on the decoded bytes. */
export const MIN_CHUNK_BYTES = 1024;
export const MAX_CHUNK_BYTES = 32 * 1024;

/**
 * The documented default. 8000 is undocumented but accepted: probed 2026-08-23 and echoed
 * back unchanged in `SESSION_CREATED.configs`, so telephony audio needs no upsampling.
 */
export const DEFAULT_SAMPLE_RATE = 16_000;

/** Server closes the session at this age. No resume, so reconnect before it. */
export const SESSION_LIMIT_MS = 300_000;

/**
 * Nigerian speech is code-switched, and the model is chosen at connect time — before
 * anybody has spoken. Which of these is right for a Lagos line is a measurement.
 */
export type IntronLanguage = "en" | "pcm" | "yo" | "ig" | "ha";

export interface IntronOptions {
  readonly format: AudioFormat;
  readonly language: IntronLanguage;
  /** Overrides the carrier's rate when the transcode upsamples. */
  readonly sampleRate?: number;
}

export const buildUrl = (host: string, options: IntronOptions): string => {
  const url = new URL(`wss://${host}/stt/v1/stream`);
  url.searchParams.set("sample_rate", String(options.sampleRate ?? options.format.sampleRate));
  url.searchParams.set("bit_rate", "16");
  url.searchParams.set("num_channels", "1");
  url.searchParams.set("use_language_asr_input", options.language);
  return url.toString();
};

export const encodeAudioChunk = (pcm: Buffer, ackId: number): string =>
  JSON.stringify({
    message_type: "INPUT_AUDIO_CHUNK",
    audio_base_64: pcm.toString("base64"),
    ack_id: ackId,
  });

export const encodeCommit = (): string => JSON.stringify({ message_type: "COMMIT" });

export type IntronEvent =
  | { readonly kind: "ready"; readonly sessionId: string; readonly sampleRate: number }
  | { readonly kind: "interim"; readonly text: string }
  | { readonly kind: "final"; readonly text: string }
  | { readonly kind: "expired" }
  | { readonly kind: "ack" }
  | { readonly kind: "other"; readonly type: string };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Null for anything unparseable, rather than a throw.
 *
 * A malformed frame is the vendor's problem and must not become a dropped call: the caller
 * is still talking and the next frame is very likely fine.
 */
export const parseEvent = (raw: string): IntronEvent | null => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const frame = asRecord(decoded);
  if (frame === null) return null;

  const type = asText(frame["message_type"]);
  switch (type) {
    case "SESSION_CREATED": {
      const configs = asRecord(frame["configs"]);
      const rate = configs?.["sample_rate"];
      return {
        kind: "ready",
        sessionId: asText(frame["session_id"]),
        /* Echoed back by the server, and the only way to discover that a requested 8000 was
           silently coerced to something else. Worth reading rather than assuming. */
        sampleRate: typeof rate === "number" ? rate : DEFAULT_SAMPLE_RATE,
      };
    }
    case "PARTIAL_TRANSCRIPT": {
      const text = asText(frame["transcript"]);
      return text === "" ? null : { kind: "interim", text };
    }
    case "COMMITTED_TRANSCRIPT": {
      // A different field name from the partial's. Reading `transcript` here returns
      // undefined and silently drops every final, which is the whole turn.
      const text = asText(frame["transcript_text"]);
      return text === "" ? null : { kind: "final", text };
    }
    case "SESSION_TIME_LIMIT_EXCEEDED":
      return { kind: "expired" };
    /* Undocumented, one per chunk, and the vendor's own spelling. Named so it does not
       arrive as an unknown message on every frame of every call. */
    case "AUDIO_CHUCK_ACK":
    case "AUDIO_CHUNK_ACK":
      return { kind: "ack" };
    default:
      return type === "" ? null : { kind: "other", type };
  }
};

/**
 * Twilio delivers 160 bytes of mu-law every 20ms; Intron refuses anything under 1 KB. So
 * frames accumulate and leave in batches, and the remainder stays for the next write.
 */
export const splitForSend = (
  pending: Buffer,
): { readonly send: readonly Buffer[]; readonly rest: Buffer } => {
  if (pending.length < MIN_CHUNK_BYTES) return { send: [], rest: pending };
  const send: Buffer[] = [];
  let offset = 0;
  while (pending.length - offset >= MIN_CHUNK_BYTES) {
    const take = Math.min(MAX_CHUNK_BYTES, pending.length - offset);
    send.push(pending.subarray(offset, offset + take));
    offset += take;
  }
  return { send, rest: pending.subarray(offset) };
};
