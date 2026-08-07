import type { AudioFormat } from "@ansa/shared";

/**
 * Deepgram Flux wire protocol, isolated so it can be tested without a socket.
 *
 * Everything here was verified against the live API on 2026-08-08 (see
 * docs/STACK_DECISION.md). Where documentation and observation disagreed, observation
 * won and the difference is noted.
 */

export interface DeepgramOptions {
  readonly format: AudioFormat;
  /** `flux-general-en`. The multilingual variant buys no African language. */
  readonly model: string;
  /**
   * Vocabulary boosting (R4.1.3) — the capability neither of the other candidates had.
   * Repeated once per term in the query string. Multi-word phrases are fine.
   */
  readonly keyterms: readonly string[];
  /**
   * 0.5–0.9. How sure Flux must be that the caller has finished. Higher interrupts less
   * and costs latency; our own history of chopping callers mid-sentence argues above the
   * 0.7 default.
   */
  readonly eotThreshold: number;
  /** Silence backstop that fires regardless of confidence. 500–60000. */
  readonly eotTimeoutMs: number;
  /** `api.deepgram.com`, or `api.eu.deepgram.com` — nearer to Lagos. */
  readonly host: string;
}

/**
 * A keyterm containing a comma or semicolon is accepted by the API, treated as one
 * literal term, and boosts nothing — silently. Confirmed on the live API: the
 * comma-joined control connected happily and returned the no-keyterm transcript.
 *
 * A typo would therefore disable the single feature we chose this provider for, with no
 * error anywhere, so it is rejected at construction instead.
 */
export const assertUsableKeyterms = (keyterms: readonly string[]): void => {
  for (const term of keyterms) {
    if (/[,;:]/.test(term)) {
      throw new Error(
        `Keyterm ${JSON.stringify(term)} contains a separator. Deepgram would accept it, ` +
          "treat it as one literal term, and silently boost nothing. Pass one term per entry.",
      );
    }
    if (term.trim().length === 0) throw new Error("Empty keyterm");
  }
};

export const buildUrl = (options: DeepgramOptions): string => {
  assertUsableKeyterms(options.keyterms);
  if (options.format.encoding !== "mulaw") {
    throw new Error(`Deepgram adapter expects mu-law, got ${options.format.encoding}`);
  }

  const params = new URLSearchParams();
  params.set("model", options.model);
  // Verified: mu-law at 8000 works on Flux, though no Deepgram example uses the pair.
  params.set("encoding", "mulaw");
  params.set("sample_rate", String(options.format.sampleRate));
  params.set("eot_threshold", String(options.eotThreshold));
  params.set("eot_timeout_ms", String(options.eotTimeoutMs));
  // One parameter per term. Comma-joining is the silent-failure mode above.
  for (const term of options.keyterms) params.append("keyterm", term);

  // /v2 is mandatory: /v1/listen does not serve Flux.
  return `wss://${options.host}/v2/listen?${params.toString()}`;
};

export interface DeepgramWord {
  readonly text: string;
  readonly confidence: number;
}

export type DeepgramEvent =
  | { readonly kind: "connected" }
  | { readonly kind: "speechStart" }
  | { readonly kind: "interim"; readonly text: string; readonly words: readonly DeepgramWord[] }
  | {
      readonly kind: "endOfTurn";
      readonly text: string;
      readonly words: readonly DeepgramWord[];
      readonly endOfTurnConfidence: number | null;
    }
  | { readonly kind: "error"; readonly message: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const readWords = (raw: unknown): DeepgramWord[] => {
  if (!Array.isArray(raw)) return [];
  const out: DeepgramWord[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const text = item["word"];
    const confidence = item["confidence"];
    if (typeof text !== "string") continue;
    out.push({ text, confidence: typeof confidence === "number" ? confidence : 0 });
  }
  return out;
};

/**
 * Parse one inbound frame. Returns null for anything unrecognised: a vendor adding an
 * event type must not take a call down.
 */
export const parseEvent = (raw: string): DeepgramEvent | null => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(decoded)) return null;

  const type = decoded["type"];
  if (type === "Connected") return { kind: "connected" };
  // Note: a fatal error arrives with type "Error", not "FatalError".
  if (type === "Error" || type === "FatalError") {
    const description = decoded["description"] ?? decoded["message"];
    return {
      kind: "error",
      message: typeof description === "string" ? description : JSON.stringify(decoded).slice(0, 200),
    };
  }
  if (type !== "TurnInfo") return null;

  const event = decoded["event"];
  const text = typeof decoded["transcript"] === "string" ? decoded["transcript"] : "";
  const words = readWords(decoded["words"]);

  if (event === "StartOfTurn") return { kind: "speechStart" };
  if (event === "Update") return { kind: "interim", text, words };
  if (event === "EndOfTurn") {
    const confidence = decoded["end_of_turn_confidence"];
    return {
      kind: "endOfTurn",
      text,
      words,
      endOfTurnConfidence: typeof confidence === "number" ? confidence : null,
    };
  }
  // EagerEndOfTurn and TurnResumed only fire when eager_eot_threshold is set, which it
  // deliberately is not: R4.1.8 forbids speculative work without proven cancellation.
  return null;
};
