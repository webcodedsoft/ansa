/**
 * How the caller sounds, judged by the model at no cost to the turn.
 *
 * Classifying sentiment properly means a second model call, and a second round trip is a
 * second of silence on a phone line — which is why this was argued against and then argued
 * back in. There is a version that costs nothing: the model appends its read *after* the
 * spoken text, on a line the caller never hears. The speech has already been synthesised
 * and is already playing by the time the marker arrives, so parsing it adds nothing to any
 * stage anybody measures.
 *
 * That only holds if the marker never reaches the speech path. `createReadStripper` sits
 * between the token stream and the sentence buffer and is the load-bearing part of this
 * file: get it wrong and the caller hears "less than less than read colon emotion equals".
 *
 * What the read may change is *how* the agent speaks, never *what is true*. The prompt
 * layer carries that rule; this module only carries the value.
 */

export const EMOTIONS = [
  "calm",
  "frustrated",
  "angry",
  "anxious",
  "confused",
  "upset",
  "pleased",
  "resigned",
  "suspicious",
] as const;

export const LEVELS = ["low", "normal", "high"] as const;

export type Emotion = (typeof EMOTIONS)[number];
export type Level = (typeof LEVELS)[number];

export interface EmotionalRead {
  readonly emotion: Emotion;
  readonly energy: Level;
  /** Whether they are doubting you or the company. */
  readonly trust: Level;
  readonly urgency: Level;
}

/** What the model is told to append, and what the stripper watches for. */
export const MARKER_START = "<<";

/**
 * Takes the model's tokens and returns only the part that may be spoken.
 *
 * Stateful and deliberately dumb: the moment `<<` appears, everything after it is marker
 * and nothing further is speakable. No attempt is made to recover speech after a marker,
 * because there never is any — the prompt puts it last, and a model that emits one
 * mid-sentence has produced a turn that was going wrong regardless.
 *
 * The subtlety is the boundary. Tokens split anywhere, so `<` can arrive alone with its
 * partner in the next token. A single trailing `<` is therefore held back rather than
 * emitted, and released by `flush` if it turns out to have been a stray character.
 */
export interface ReadStripper {
  /** The speakable part of this token. Empty once the marker has started. */
  push(token: string): string;
  /** Anything held back that turned out not to be a marker after all. */
  flush(): string;
  /** The marker text, or null when the model emitted none. */
  marker(): string | null;
}

export const createReadStripper = (): ReadStripper => {
  let pending = "";
  let marker: string | null = null;

  return {
    push(token: string): string {
      if (marker !== null) {
        marker += token;
        return "";
      }

      pending += token;
      const at = pending.indexOf(MARKER_START);
      if (at !== -1) {
        const speakable = pending.slice(0, at);
        marker = pending.slice(at);
        pending = "";
        return speakable;
      }

      /* A lone trailing `<` could be the first half of the marker, so it waits for the next
         token rather than going to TTS. Everything else goes now — holding a whole token
         back would delay the first sentence, which is the one thing this layer exists to
         avoid. */
      if (pending.endsWith("<")) {
        const out = pending.slice(0, -1);
        pending = "<";
        return out;
      }

      const out = pending;
      pending = "";
      return out;
    },

    flush(): string {
      if (marker !== null) return "";
      const out = pending;
      pending = "";
      return out;
    },

    marker: () => marker,
  };
};

const isEmotion = (value: string): value is Emotion =>
  (EMOTIONS as readonly string[]).includes(value);
const isLevel = (value: string): value is Level => (LEVELS as readonly string[]).includes(value);

const FIELD = /(\w+)\s*=\s*([a-z]+)/gi;

/**
 * The marker as a read, or null when it is missing or malformed.
 *
 * Null is expected rather than exceptional, and the caller must treat it that way: keep the
 * previous read and carry on. A model that forgot the line, or wrote `emotion=annoyed`, has
 * produced a turn that was otherwise fine, and failing it over a metadata line the caller
 * cannot hear would be the worst trade available.
 *
 * Unknown values are dropped rather than coerced. `annoyed` is not in the vocabulary, and
 * deciding it means `frustrated` puts a word in the model's mouth it did not choose — the
 * point of a closed vocabulary is that next turn's guidance keys off it exactly.
 */
export const parseRead = (marker: string | null): EmotionalRead | null => {
  if (marker === null) return null;

  const found = new Map<string, string>();
  for (const match of marker.matchAll(FIELD)) {
    const key = match[1]?.toLowerCase();
    const value = match[2]?.toLowerCase();
    if (key !== undefined && value !== undefined) found.set(key, value);
  }

  const emotion = found.get("emotion");
  /* Emotion is the one that has to be there. The three levels each fall back to `normal`,
     which is what "they did not say" means for a scale and does not mean for a feeling. */
  if (emotion === undefined || !isEmotion(emotion)) return null;

  const level = (key: string): Level => {
    const value = found.get(key);
    return value !== undefined && isLevel(value) ? value : "normal";
  };

  return { emotion, energy: level("energy"), trust: level("trust"), urgency: level("urgency") };
};

/**
 * How bad a state is to be in, for comparing this turn against the last.
 *
 * A ranking rather than a set of rules, because the direction of travel is what matters:
 * the same caller at "frustrated" is a different call depending on whether they were calm
 * or angry a minute ago. `resigned` ranks with `angry` and not with `calm` — it reads as
 * calm and it is not, it is somebody who has given up on you, and scoring it as an
 * improvement is exactly the mistake this ranking exists to prevent.
 */
const SEVERITY: Readonly<Record<Emotion, number>> = {
  pleased: 0,
  calm: 1,
  confused: 2,
  anxious: 3,
  suspicious: 3,
  frustrated: 4,
  upset: 5,
  angry: 6,
  resigned: 6,
};

export type Trajectory = "worsening" | "easing" | "steady";

export const trajectoryOf = (current: EmotionalRead, previous: EmotionalRead | null): Trajectory => {
  if (previous === null) return "steady";
  /* Trust counts alongside the feeling. A caller who has stopped believing you while
     staying outwardly calm is going the wrong way, and the emotion word alone misses it. */
  const score = (read: EmotionalRead): number =>
    SEVERITY[read.emotion] + (read.trust === "low" ? 2 : read.trust === "high" ? -1 : 0);

  const delta = score(current) - score(previous);
  if (delta > 0) return "worsening";
  if (delta < 0) return "easing";
  return "steady";
};

/**
 * The line the model reads next turn, or null when there is nothing yet.
 *
 * Terse, and deliberately carrying no advice. What to do about each state is static and
 * lives in the prompt layer where caching can hold it; this changes every turn and is paid
 * for every turn.
 */
export const renderRead = (
  current: EmotionalRead | null,
  previous: EmotionalRead | null,
): string | null => {
  if (current === null) return null;

  const trajectory = trajectoryOf(current, previous);
  const moved = previous !== null && previous.emotion !== current.emotion;
  const was = moved ? ` (was ${previous?.emotion ?? ""} — ${trajectory})` : "";
  /* Named even when the word has not changed, because trust moving underneath a steady
     emotion is the quieter signal and the one an agent misses. */
  const drift = !moved && trajectory !== "steady" ? ` (${trajectory})` : "";

  return [
    `How they sound: ${current.emotion}${was}${drift}.`,
    `Energy ${current.energy}. Trust ${current.trust}. Urgency ${current.urgency}.`,
    "Let this change how you speak. Never say it out loud.",
  ].join("\n");
};
