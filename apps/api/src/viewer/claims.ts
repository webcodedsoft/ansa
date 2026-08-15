import type { ClaimSource, CorpusEntry } from "@ansa/db";

/**
 * A reviewed call, written as an `eval/` claim file (R9.2.4).
 *
 * `eval/verdict.py` scores a transcriber against ground truth and refuses to score anything
 * without it. A corrected transcript is exactly the pair it wants: `heard` is a candidate's
 * output and `corrected` is what a human says was said. Until now those pairs left the
 * system as a bespoke JSONL that only the viewer understood, so the corpus and the scorer
 * spoke different formats and the corpus grew into a file nothing read.
 *
 * This emits the format the scorer already takes, so a call reviewed this morning is a
 * regression test this afternoon without a labelling project. Rule 0 holds: `eval/` stays
 * standard-library Python and imports nothing; this is TypeScript and writes a file it can
 * read.
 *
 * ## Three refusals inherited from the tool, on purpose
 *
 * **1. A turn nobody can classify is `unlabelled`, not guessed.** `verdict.py` scores two
 * kinds, `name` and `identifier`, each with its own canonicalisation, and it has no prose
 * path at all — WER machinery is deferred until there is a hand transcript to run it
 * against. Most corrected turns are prose. They go into `unlabelled` with the reason,
 * exactly as the hand-written claim does for the policy number nobody wrote down. A prose
 * turn labelled `identifier` would canonicalise to gibberish and produce a MISS that says
 * nothing about the transcriber.
 *
 * **2. A configuration field that was not recorded is emitted as null, not filled in.**
 * The tool refuses a configuration missing any of provider, model, encoding, sample_rate,
 * language or endpointing, because a result nobody can reproduce cannot be compared with
 * anything. Deepgram's `call configuration` event records no language, so a Deepgram claim
 * comes out refused until someone writes one down. That is the correct outcome and it is
 * visible, which is better than a claim that scores against an invented setting.
 *
 * **3. One production call is one trial, and one trial is not a measurement.** The heard
 * text is emitted as a single inline trial, so `verdict.py` prints it as an observation and
 * refuses a verdict at n=1. Padding it to three by repeating it would manufacture the exact
 * agreement the three-trial rule exists to detect. Three trials come from re-running a
 * candidate over the audio; this file supplies the truth to run them against.
 */

/** The subset of `verdict.py`'s claim shape this exporter produces. */
export interface ClaimItem {
  readonly id: string;
  readonly kind: "name" | "identifier";
  readonly truth: string;
  readonly source: string;
}

export interface ClaimGap {
  readonly id: string;
  readonly kind: string;
  readonly reason: string;
}

export interface Claim {
  readonly claim: string;
  readonly audio: string;
  readonly _provenance: readonly string[];
  readonly expected: readonly ClaimItem[];
  readonly unlabelled: readonly ClaimGap[];
  readonly configurations: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

const stringOr = (value: unknown, fallback: string | null): string | null =>
  typeof value === "string" && value !== "" ? value : fallback;

const numberOr = (value: unknown, fallback: number | null): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * Every token an identifier is allowed to be made of.
 *
 * Mirrors `verdict.py`'s own `_IDENTIFIERISH` rather than reimplementing its judgement:
 * digits, single letters, the number words a caller says, and the repeat words. If the two
 * ever disagree, the tool wins — this side only decides whether to offer the item at all.
 */
const NUMBER_WORDS: ReadonlySet<string> = new Set([
  "zero", "oh", "o", "nought", "naught", "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fourty",
  "fifty", "sixty", "seventy", "eighty", "ninety", "double", "triple", "treble",
]);

const tokensOf = (text: string): readonly string[] =>
  text
    .split(/[^0-9A-Za-z'-]+/)
    .filter((t) => t !== "" && t !== "'" && t !== "-");

/**
 * What kind of item a corrected turn is, or null for "do not offer it".
 *
 * Conservative in one direction on purpose. A misclassification here cannot manufacture a
 * false match — `verdict.py` compares against the exact truth string either way — but it
 * can manufacture a false MISS, and a queue of false alarms is how a measurement tool stops
 * being read. So an item is offered only when the whole turn is one thing:
 *
 * - **identifier**: every token is a digit run, a single letter or a number word, and at
 *   least one of them carries a digit or is a number word. "P M 8 5 9 2 6 2 5" qualifies;
 *   "my policy number is PM8592625" does not, because the truth for that turn is the
 *   identifier and not the sentence, and nobody has said which part of the sentence it is.
 * - **name**: one to three tokens, all alphabetic, all capitalised *in the reviewer's own
 *   text*. That capitalisation is a human's signal, not this file's inference. "Sikiru"
 *   qualifies; "my name is Sikiru" does not.
 *
 * Everything else is prose and goes to `unlabelled`. The gap that leaves — a name or a
 * number said inside a sentence, which is how callers actually say them — needs the reviewer
 * to be able to mark a span, and there is nowhere to store that today. It is named in the
 * slice report rather than papered over with a regex.
 */
const classify = (corrected: string): "name" | "identifier" | null => {
  const tokens = tokensOf(corrected);
  if (tokens.length === 0) return null;

  const identifierish = tokens.every(
    (t) => /[0-9]/.test(t) || t.length === 1 || NUMBER_WORDS.has(t.toLowerCase()),
  );
  const carriesANumber = tokens.some((t) => /[0-9]/.test(t) || NUMBER_WORDS.has(t.toLowerCase()));
  if (identifierish && carriesANumber) return "identifier";

  if (tokens.length <= 3 && tokens.every((t) => /^[A-Z][a-z'-]+$/.test(t))) return "name";
  return null;
};

/**
 * The claim's `configurations` block, from the `call configuration` event.
 *
 * One entry per transcriber that produced a corrected turn on this call — usually one, two
 * when `LISTEN_PROVIDER=composite` has a second vendor on the same audio (R4.1.9). Each
 * carries only the trials that vendor produced, because a trial attributed to the wrong
 * provider is worse than a missing one.
 *
 * The six required keys are read from the event where it recorded them and left null where
 * it did not. `endpointing` is assembled from whichever thresholds the provider wrote, and
 * is null when it wrote none — see refusal 2 in the header.
 */
const configurationsFor = (
  source: ClaimSource,
  byProvider: ReadonlyMap<string, readonly CorpusEntry[]>,
): Record<string, Record<string, unknown>> => {
  const recorded = source.listenConfig ?? {};
  const eot = numberOr(recorded["eotThreshold"], null);
  const eotTimeout = numberOr(recorded["eotTimeoutMs"], null);
  const turnDetection = stringOr(recorded["turnDetection"], null);
  const eagerness = stringOr(recorded["eagerness"], null);

  const endpointing =
    eot !== null || eotTimeout !== null
      ? `eot_threshold=${eot ?? "?"}, eot_timeout_ms=${eotTimeout ?? "?"}`
      : turnDetection !== null
        ? `${turnDetection}${eagerness === null ? "" : `/${eagerness}`}`
        : null;

  const out: Record<string, Record<string, unknown>> = {};
  for (const [provider, entries] of byProvider) {
    out[`${provider} (production, ${source.carrierCallId})`] = {
      provider,
      model: stringOr(recorded["model"], null),
      encoding: stringOr(recorded["encoding"], null),
      sample_rate: numberOr(recorded["sampleRate"], null),
      language: stringOr(recorded["language"], null),
      endpointing,
      // Deepgram records how many keyterms were sent rather than which; the list is the
      // organization's configuration and is versioned there. The count is what a reader needs to
      // know a boost was in effect at all, which is the thing `defaults.ts` warns about.
      keyterms_sent: numberOr(recorded["keyterms"], null),
      config_version: source.configVersion,
      // One per corrected turn, in the order the caller spoke them. See refusal 3: this is
      // n=1 per item and the tool will say so.
      trials: entries.map((entry) => entry.heard),
    };
  }
  return out;
};

/**
 * One call's reviewed turns as a claim file.
 *
 * `audio` names the recording this claim is about whether or not it still exists — the
 * carrier's id is what `RECORD_AUDIO_DIR` keys on and what the retention sweep deletes by,
 * so a claim written after the audio expired still says which call it came from. The
 * transcript side is stored apart from the audio for the reason the hand-written claim
 * gives: one is a person's voice and the other is text a human already read.
 */
export const buildClaim = (source: ClaimSource, audioDir = "recordings"): Claim => {
  const byProvider = new Map<string, CorpusEntry[]>();
  for (const entry of source.entries) {
    const list = byProvider.get(entry.provider) ?? [];
    list.push(entry);
    byProvider.set(entry.provider, list);
  }

  const expected: ClaimItem[] = [];
  const unlabelled: ClaimGap[] = [];
  for (const entry of source.entries) {
    const kind = classify(entry.corrected);
    const id = `t${entry.transcriptId}@${entry.offsetMs}ms`;
    if (kind === null) {
      unlabelled.push({
        id,
        kind: "prose",
        reason:
          "a reviewer corrected this whole turn, but the truth for a turn is not the same " +
          "thing as the truth for an item inside it, and nobody has marked which span is " +
          "the name or the number. verdict.py scores names and identifiers only; prose " +
          "scoring is deferred with the rest of Gate A (eval/README.md).",
      });
      continue;
    }
    expected.push({
      kind,
      id,
      truth: entry.corrected,
      source: `a reviewer, ${entry.correctedAt.toISOString()}, on call ${source.carrierCallId}`,
    });
  }

  return {
    claim: `Reviewed turns from call ${source.carrierCallId}`,
    audio: `${audioDir}/${source.carrierCallId}.ulaw`,
    _provenance: [
      "Generated from the post-call review loop (R9.2.4), not written by hand.",
      "",
      "Every truth string below is what a human typed into the review form after reading",
      "what the transcriber produced. Nothing here was derived from a transcriber's own",
      "output, which R9.1.4 forbids, and nothing was matched against a pattern.",
      "",
      "The trials under each configuration are the production transcripts from that one",
      "call: n=1 per item. verdict.py will print them as observations and refuse a verdict,",
      "which is correct — three runs come from re-running a candidate over the audio. This",
      "file exists to give those runs something true to be scored against.",
      "",
      "Configuration fields are read from the call's own `call configuration` event. A null",
      "is a setting that was never written down, and the tool refuses rather than scores it.",
    ],
    expected,
    unlabelled,
    configurations: configurationsFor(source, byProvider),
  };
};

/** Pretty-printed, because a claim file is read by people and diffed in review. */
export const renderClaim = (source: ClaimSource): string =>
  `${JSON.stringify(buildClaim(source), null, 2)}\n`;
