import type { AudioFormat } from "@ansa/shared";

/**
 * The realtime transcription wire protocol, isolated so it can be tested without a
 * socket. The Beta shape is retired; this is the GA schema, where audio configuration
 * lives under `session.audio.input`.
 */

export const toInputFormat = (format: AudioFormat): { type: string } => {
  if (format.encoding === "mulaw" && format.sampleRate === 8000) return { type: "audio/pcmu" };
  if (format.encoding === "linear16") return { type: "audio/pcm" };
  throw new Error(`No realtime input format for ${format.encoding}@${format.sampleRate}Hz`);
};

/**
 * How the end of a caller's turn is decided.
 *
 * `server_vad` is a stopwatch: commit after N milliseconds of silence. It cannot tell a
 * thinking pause from a finished sentence, so every value is wrong for someone — at
 * 500ms a live caller was chopped mid-sentence ("Well, I would like to..."), and raising
 * it just adds latency to everyone else.
 *
 * `semantic_vad` decides from what was actually said: an unfinished clause holds the
 * turn open, a complete one commits. `eagerness` biases that judgement — `low` waits
 * longer and interrupts less. This is the closest thing this provider has to the
 * model-native end-of-turn detection R4.1.6 asks for.
 */
export type TurnDetection =
  | { readonly type: "server_vad"; readonly silenceMs: number }
  | { readonly type: "semantic_vad"; readonly eagerness: "auto" | "low" | "medium" | "high" };

export interface SessionOptions {
  readonly format: AudioFormat;
  readonly model: string;
  readonly turnDetection: TurnDetection;
  /**
   * Domain vocabulary (R4.1.3). Currently unused: this provider offers no vocabulary
   * boosting, and the prompt field it does offer hallucinates its contents back as
   * transcripts. Kept on the interface because the requirement is real and the next
   * provider may honour it.
   */
  readonly keyterms: readonly string[];
}

export const encodeSessionUpdate = (options: SessionOptions): string =>
  JSON.stringify({
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: toInputFormat(options.format),
          // NOTE: no `prompt` here, deliberately.
          //
          // Whisper-family models regurgitate their prompt when fed silence or noise.
          // Passing keyterms that way produced phantom caller turns reading "Expect
          // these terms: Ansa, policy, premium, naira." on a live call, which the agent
          // then answered. Keyterm biasing needs a provider that supports it as real
          // vocabulary boosting (R4.1.3), not as prompt text — another thing for Gate A
          // to weigh.
          transcription: { model: options.model, language: "en" },
          turn_detection:
            options.turnDetection.type === "semantic_vad"
              ? { type: "semantic_vad", eagerness: options.turnDetection.eagerness }
              : { type: "server_vad", silence_duration_ms: options.turnDetection.silenceMs },
        },
      },
    },
  });

export const encodeAudioAppend = (payload: Buffer): string =>
  JSON.stringify({ type: "input_audio_buffer.append", audio: payload.toString("base64") });

export type ListenEvent =
  | { readonly kind: "ready" }
  | { readonly kind: "speechStart"; readonly offsetMs: number | null }
  | { readonly kind: "endOfTurn"; readonly offsetMs: number | null }
  | { readonly kind: "interim"; readonly text: string }
  | { readonly kind: "final"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

const readString = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const readNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Parse one inbound event. Returns null for anything unrecognised: a vendor adding an
 * event type must not take a call down.
 */
export const parseEvent = (raw: string): ListenEvent | null => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) return null;
  const e = decoded as Record<string, unknown>;
  const type = readString(e["type"]);
  if (type === null) return null;

  if (type === "session.updated") return { kind: "ready" };

  if (type === "error") {
    const err = e["error"];
    const message =
      typeof err === "object" && err !== null
        ? (readString((err as Record<string, unknown>)["message"]) ?? "realtime error")
        : "realtime error";
    return { kind: "error", message };
  }

  if (type === "input_audio_buffer.speech_started") {
    return { kind: "speechStart", offsetMs: readNumber(e["audio_start_ms"]) };
  }
  if (type === "input_audio_buffer.speech_stopped") {
    return { kind: "endOfTurn", offsetMs: readNumber(e["audio_end_ms"]) };
  }

  if (type.endsWith("input_audio_transcription.delta")) {
    const text = readString(e["delta"]);
    return text === null ? null : { kind: "interim", text };
  }
  if (type.endsWith("input_audio_transcription.completed")) {
    const text = readString(e["transcript"]);
    return text === null ? null : { kind: "final", text };
  }

  return null;
};
