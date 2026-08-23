import type { AudioFormat } from "@ansa/shared";
import type {
  RealtimeAudioFormats,
  RealtimeServerEvent,
  SessionUpdateEvent,
} from "openai/resources/realtime/realtime";

/**
 * The realtime transcription wire protocol, isolated so it can be tested without a
 * socket. The Beta shape is retired; this is the GA schema, where audio configuration
 * lives under `session.audio.input`.
 *
 * The wire shapes are the vendor's own types rather than hand-written structs. Nothing
 * here calls the SDK — the socket stays a plain WebSocket, because the SDK's realtime
 * client cannot open an `?intent=transcription` session and does no buffering of its own.
 * What the types buy is that a renamed field or a mistyped event name fails `typecheck`
 * instead of failing silently on a call, which is where this project's expensive bugs
 * have always surfaced.
 */

/** The rate this provider's documentation specifies for PCM input. */
export const PCM_RATE = 24_000;

/**
 * What we tell the provider we are sending.
 *
 * `pcm24` transcodes the carrier's mu-law on the way out. The documentation specifies
 * audio/pcm at 24kHz; audio/pcmu is accepted but undocumented, and whether that costs
 * accuracy on an already-poor channel is a measurement rather than an argument — hence
 * a flag rather than a decision.
 *
 * Measured 2026-08-08 on one synthetic control: the two produced byte-identical
 * transcripts and pcmu committed the turn sooner. That is clean audio, not a phone line,
 * so the flag stays.
 */
export const toInputFormat = (format: AudioFormat, asPcm = false): RealtimeAudioFormats => {
  if (asPcm) return { type: "audio/pcm", rate: PCM_RATE };
  if (format.encoding === "mulaw" && format.sampleRate === 8000) return { type: "audio/pcmu" };
  // 24kHz is the only PCM rate the schema admits. Passing the carrier's rate through
  // built a request the provider cannot honour; the vendor types are what surfaced it.
  if (format.encoding === "linear16" && format.sampleRate === PCM_RATE) {
    return { type: "audio/pcm", rate: PCM_RATE };
  }
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
   * Domain vocabulary (R4.1.3). Still unused, but the reason has changed and the old one
   * is no longer true.
   *
   * The vendor schema now carries a first-class `keywords` field — real vocabulary
   * boosting, not the `prompt` field that used to regurgitate its own contents as
   * phantom caller turns. It is **not supported on `gpt-4o-transcribe`**, which is what
   * `TRANSCRIPTION_MODEL` is set to; the schema documents it for `gpt-transcribe` and
   * `gpt-live-transcribe` only. So wiring it means changing model first.
   *
   * Do not wire it on the strength of that alone. Measured 2026-08-08: Deepgram's
   * equivalent turned "Sikiru" into "Akiro", deterministically, with no personal name in
   * the list — boosting domain words was enough to damage an adjacent proper noun. The
   * same A/B is owed here before this field is honoured.
   */
  readonly keyterms: readonly string[];
  /** Transcode mu-law to 24kHz PCM before sending. See toInputFormat. */
  readonly sendAsPcm?: boolean;
}

export const encodeSessionUpdate = (options: SessionOptions): string => {
  // Typed as the vendor's own client event. Every field name below is now checked
  // against the published schema at build time rather than against our memory of it.
  const event: SessionUpdateEvent = {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: toInputFormat(options.format, options.sendAsPcm ?? false),
          // NOTE: no `prompt` here, deliberately.
          //
          // Whisper-family models regurgitate their prompt when fed silence or noise.
          // Passing keyterms that way produced phantom caller turns reading "Expect
          // these terms: Ansa, policy, premium, naira." on a live call, which the agent
          // then answered. Keyterm biasing needs a provider that supports it as real
          // vocabulary boosting (R4.1.3), not as prompt text.
          //
          // Retested properly on 2026-08-23, because "use a better prompt" is the obvious
          // objection to the paragraph above. Four designs, same recording, against the
          // no-prompt control:
          //
          //   no prompt                      -> "my name is Sikiru"      (correct, twice)
          //   "expect Nigerian names"        -> "Chukwu", then "Sekou"   (both wrong)
          //   register only, no proper nouns -> "Good afternoon."        (name lost)
          //   transcript fragment w/ digits  -> the prompt, word for word, as caller speech
          //
          // The last two are the important ones. Written as instructions it primes the
          // set and the model picks the wrong member confidently; written as a transcript
          // fragment — which is what the field actually is — the model continues it, and
          // the caller's first turn comes back as the prompt itself. Anything specific
          // enough to help is specific enough to be spoken. The field is not usable here.
          transcription: { model: options.model, language: "en" },
          turn_detection:
            options.turnDetection.type === "semantic_vad"
              ? { type: "semantic_vad", eagerness: options.turnDetection.eagerness }
              : { type: "server_vad", silence_duration_ms: options.turnDetection.silenceMs },
        },
      },
    },
  };
  return JSON.stringify(event);
};

export const encodeAudioAppend = (payload: Buffer): string =>
  JSON.stringify({ type: "input_audio_buffer.append", audio: payload.toString("base64") });

export type ListenEvent =
  | { readonly kind: "ready" }
  | { readonly kind: "speechStart"; readonly offsetMs: number | null }
  | { readonly kind: "endOfTurn"; readonly offsetMs: number | null }
  | { readonly kind: "interim"; readonly text: string }
  | { readonly kind: "final"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * The event names we act on, pinned to the vendor's server-event union.
 *
 * The runtime parsing below stays defensive — a vendor adding an event must not take a
 * call down, so unknown types return null rather than throwing. What this adds is the
 * other direction: if the provider *renames or removes* one of these, the annotation
 * stops compiling. Previously a rename would have compiled cleanly and simply stopped
 * matching, which reads on a call as an agent that has gone deaf.
 */
type ServerEventType = RealtimeServerEvent["type"];

const SESSION_UPDATED: ServerEventType = "session.updated";
const ERROR: ServerEventType = "error";
const SPEECH_STARTED: ServerEventType = "input_audio_buffer.speech_started";
const SPEECH_STOPPED: ServerEventType = "input_audio_buffer.speech_stopped";
const TRANSCRIPTION_DELTA: ServerEventType =
  "conversation.item.input_audio_transcription.delta";
const TRANSCRIPTION_COMPLETED: ServerEventType =
  "conversation.item.input_audio_transcription.completed";

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

  if (type === SESSION_UPDATED) return { kind: "ready" };

  if (type === ERROR) {
    const err = e["error"];
    const message =
      typeof err === "object" && err !== null
        ? (readString((err as Record<string, unknown>)["message"]) ?? "realtime error")
        : "realtime error";
    return { kind: "error", message };
  }

  if (type === SPEECH_STARTED) {
    return { kind: "speechStart", offsetMs: readNumber(e["audio_start_ms"]) };
  }
  if (type === SPEECH_STOPPED) {
    return { kind: "endOfTurn", offsetMs: readNumber(e["audio_end_ms"]) };
  }

  // Exact GA name first, then a suffix match. The suffix is what the retired Beta schema
  // emitted under a different prefix, and it is kept because no call has yet proven the
  // old shape is gone from every session. Matching is unchanged from before the vendor
  // types went in — only the GA spelling is now compiler-checked.
  if (type === TRANSCRIPTION_DELTA || type.endsWith("input_audio_transcription.delta")) {
    const text = readString(e["delta"]);
    return text === null ? null : { kind: "interim", text };
  }
  if (type === TRANSCRIPTION_COMPLETED || type.endsWith("input_audio_transcription.completed")) {
    const text = readString(e["transcript"]);
    return text === null ? null : { kind: "final", text };
  }

  return null;
};
