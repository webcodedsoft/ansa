import { forSpeech, parseSpelledName, parseSpokenDigits, sayReference } from "@ansa/normalizer";

/**
 * Readback (R4.3.1).
 *
 * A number captured from speech is never usable until the caller has heard it back and
 * agreed. This is a state machine rather than a prompt instruction for the reason
 * CLAUDE.md gives: a prompt can be talked out of things and a dispatch path cannot. A
 * tenant who writes "skip the readback, our customers find it slow" changes nothing
 * here, and neither does a caller who insists they already said it.
 *
 * There is deliberately no confidence threshold that skips the readback. Word confidence
 * on 8kHz telephony audio is not correctness — the transcriber has been confidently
 * wrong about "policy" on this very line — and a threshold would make the skip most
 * likely exactly when the line is worst.
 */

/** R4.3.3: the keypad is offered after two failed spoken attempts, not sooner. */
const MAX_SPOKEN_ATTEMPTS = 2;

/**
 * What is being captured. It changes the fallback, not the flow: a number the caller
 * cannot get across goes to the keypad, and a name goes to spelling — there is no key
 * for "Sikiru".
 */
export type CaptureSubject = "number" | "name";

export type CaptureState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "confirming";
      readonly value: string;
      readonly attempt: number;
      readonly subject: CaptureSubject;
    }
  | { readonly kind: "spelling"; readonly attempt: number }
  | { readonly kind: "keypad"; readonly digits: string; readonly attempt: number }
  | { readonly kind: "confirmed"; readonly value: string }
  | { readonly kind: "escalate" };

export type CaptureEvent =
  | { readonly kind: "speech"; readonly text: string }
  | { readonly kind: "keypad"; readonly digit: string };

export interface CaptureResult {
  readonly state: CaptureState;
  /** What the agent must say next, normalized. Null means the turn belongs to the LLM. */
  readonly say: string | null;
  /** Non-null only once confirmed. Nothing downstream may read a value before this. */
  readonly captured: string | null;
}

export const idle: CaptureState = { kind: "idle" };

/** Words that mean the caller is dictating something they expect to be acted on. */
const REFERENCE_CUE =
  /\b(policy|reference|ref|claim|account|acct|number|code|pin|otp|nin|bvn|phone|mobile|call me on)\b/i;

/**
 * Whether a value the caller said is a reference to confirm or just a quantity.
 *
 * Reading back every number would be intolerable — "you have three policies, let me read
 * that back, three, is that correct?" — so the trigger lives here rather than inside the
 * state machine, which stays about what to do once capturing has begun.
 *
 * A letter, a leading zero, or four or more characters means a reference by shape. A cue
 * word means one by context. "I have 3 policies" is neither.
 */
export const worthConfirming = (value: string, text: string): boolean =>
  /[A-Z]/.test(value) ||
  value.startsWith("0") ||
  value.length >= 4 ||
  REFERENCE_CUE.test(text);

/**
 * Agreement, including the Nigerian forms. "Na so" is as common as "yes", and an agent
 * that only recognises "yes" makes the caller repeat themselves.
 *
 * Bare "right" and bare "okay" were here and were removed. Both are discourse markers
 * before they are agreement — a caller opened a turn with "Right? What'd be good?" on a
 * live call — and treating them as confirmation of a number is not a risk worth taking.
 */
const YES =
  /\b(yes|yeah|yep|yup|correct|exactly|perfect|that'?s? (it|right|correct)|na so|sure|spot on)\b/i;

/**
 * Disagreement. "Nope" and "wrong" matter, and so does a bare "no" — which the noise
 * filter used to discard and which is the single most important word in this exchange.
 */
const NO = /\b(no|nope|nah|wrong|incorrect|not (right|correct|it)|mistake)\b/i;

/** Agreement that merely contains a "no". Nigerian English uses all three. */
const FALSE_NEGATIVES = /\bno (problem|worries|wahala)\b/gi;

/**
 * Signals that whatever agreement is in the turn is qualified, and so is not agreement.
 *
 * On a live call the caller answered a readback with "Yeah. You tried. But what about
 * the security?" — "yeah" matched, and a name the caller was plainly querying was
 * confirmed and then used to their face. A hedge or a question means ask again; the cost
 * of one more question is nothing beside acting on the wrong value.
 */
const HEDGED = /\b(but|however|although|though|except|actually|wait)\b|\?/i;

/**
 * What the agent says while confirming, and it is deliberately short.
 *
 * The first version of this said "Let me make sure I have that right. Aditi. Have I got
 * that?" — every time, word for word, including when asking twice in a row. On a live
 * call that turned a conversation into a form being read aloud, and the spelling prompt
 * ran to seven and a half seconds of unbroken agent speech.
 *
 * A person confirming a name says the name and two or three words. They also do not
 * repeat themselves verbatim: hearing the identical sentence again is how a caller
 * learns they are talking to a machine, so the second attempt is phrased as a person
 * would phrase it — shorter, and audibly a second attempt.
 */
const readback = (value: string, subject: CaptureSubject, attempt: number): string => {
  const spoken = subject === "name" ? value : sayReference(value);
  if (attempt <= 1) {
    return forSpeech(
      subject === "name" ? `${spoken} — have I got that right?` : `Let me read that back — ${spoken}. Is that right?`,
    );
  }
  // Second time of asking. Shorter, and it acknowledges that it is the second time.
  return forSpeech(`Sorry — ${spoken}. Is that right?`);
};

/**
 * Asks for a spelling, and only explains how on the second attempt.
 *
 * Leading with the full instruction is what produced the seven-second monologue. Most
 * callers just spell it; the ones who need the hint get it when they need it.
 */
const spellPromptFor = (attempt: number): string =>
  attempt <= 0
    ? forSpeech("Sorry about that. Could you spell it for me?")
    // B, C, D, E, G, P, T, V, Z and J all rhyme, and 8kHz strips the high-frequency
    // detail that separates them, so bare letters are what this channel is worst at. A
    // word per letter replaces a one-phoneme distinction with a whole-word one.
    : forSpeech("Take it slowly for me — a word for each letter, like A for Abuja.");

const keypadPrompt = forSpeech("Could you type it on your keypad, then press hash?");

/** Asking again after a rejection. Short, because they already know what we want. */
const retry = forSpeech("Sorry — once more, slowly?");

const escalation = forSpeech("Let me get a colleague for you.");

/** How a caller introduces themselves. Deliberately explicit forms only. */
const NAME_CUE = /\b(?:my name is|my name's|the name is|i am called|i'm called|call me)\s+(.*)$/i;

/**
 * The name in a caller's turn, if they gave one.
 *
 * Matched against a single sentence rather than the whole turn: "My name is Hill. How
 * are you doing?" must yield "Hill", not "Hill How are you doing".
 */
export const nameFrom = (text: string): string | null => {
  for (const sentence of text.split(/[.?!]+/)) {
    const match = NAME_CUE.exec(sentence.trim());
    if (match === null) continue;

    const rest = (match[1] ?? "").trim();
    // At most two words: a first name, or a first and last. More than that is the
    // transcriber running on, not a longer name.
    const words = rest.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z'-]*$/.test(w)).slice(0, 2);
    if (words.length === 0) continue;
    return words.join(" ");
  }
  return null;
};

/** Begin a capture of a value the orchestrator has already decided is worth confirming. */
const beginCapture = (value: string, subject: CaptureSubject): CaptureResult => ({
  state: { kind: "confirming", value, attempt: 1, subject },
  say: readback(value, subject, 1),
  captured: null,
});

/**
 * Begin a capture. The caller's turn is searched for a value; no value, no state change.
 *
 * A name is looked for first. "My policy number is four one seven" contains no name cue
 * and "my name is Hill" contains no digits, so the two do not compete in practice — but
 * when a caller gives both, who they are is the thing the transcriber is worse at.
 */
const start = (text: string): CaptureResult => {
  const name = nameFrom(text);
  if (name !== null) return beginCapture(name, "name");

  const value = parseSpokenDigits(text);
  if (value === null) return { state: idle, say: null, captured: null };
  return beginCapture(value, "number");
};

/** Where a caller goes when speech has failed twice: keypad for a number, spelling for a name. */
const fallbackFor = (subject: CaptureSubject): CaptureResult =>
  subject === "name"
    ? { state: { kind: "spelling", attempt: 0 }, say: spellPromptFor(0), captured: null }
    : { state: { kind: "keypad", digits: "", attempt: 0 }, say: keypadPrompt, captured: null };

const spelling = (
  state: { readonly attempt: number },
  text: string,
): CaptureResult => {
  const spelled = parseSpelledName(text);
  if (spelled !== null) {
    return {
      state: { kind: "confirming", value: spelled, attempt: 1, subject: "name" },
      say: readback(spelled, "name", 1),
      captured: null,
    };
  }

  // They answered something other than a spelling. Ask once more, then hand over.
  if (state.attempt >= 1) {
    return { state: { kind: "escalate" }, say: escalation, captured: null };
  }
  return {
    state: { kind: "spelling", attempt: state.attempt + 1 },
    say: spellPromptFor(state.attempt + 1),
    captured: null,
  };
};

const confirming = (
  state: { readonly value: string; readonly attempt: number; readonly subject: CaptureSubject },
  text: string,
): CaptureResult => {
  // A name is never re-read from free speech: the transcriber already proved it cannot
  // hear it, and re-parsing produces a third wrong spelling rather than a correction.
  const said = state.subject === "name" ? null : parseSpokenDigits(text);

  // Order matters. A caller correcting a digit usually says "no, it's four one eight" —
  // rejection and correction in one breath. Checking for a value first would accept the
  // correction silently; checking for "no" first and stopping would throw it away.
  //
  // Rejection then beats agreement outright. This was `NO.test(text) && !YES.test(text)`
  // and it confirmed a number on a live call: "No. No. That's not correct." matches NO,
  // but "correct" also matched YES, so the guard cancelled the rejection and the value
  // went through. The costs are not symmetric — a false rejection asks once more, a
  // false confirmation is the wrong number acted on, which is the whole failure R4.3.1
  // exists to prevent — so anything that sounds like "no" is a no.
  const rejected = NO.test(text.replace(FALSE_NEGATIVES, " "));

  if (said !== null && said !== state.value) {
    // A different value, whether or not they said "no", is a correction. It restarts the
    // readback rather than being taken at face value — the correction is speech too, and
    // R4.3.1 does not exempt it.
    return {
      state: { kind: "confirming", value: said, attempt: state.attempt + 1, subject: state.subject },
      say: readback(said, state.subject, 1),
      captured: null,
    };
  }

  if (rejected) {
    // A rejected name goes straight to spelling. Asking someone to say it again slowly
    // is what produced "Hill", then "Sequium", then "Security security security".
    if (state.subject === "name" || state.attempt >= MAX_SPOKEN_ATTEMPTS) {
      return fallbackFor(state.subject);
    }
    return {
      state: { kind: "confirming", value: state.value, attempt: state.attempt + 1, subject: state.subject },
      say: retry,
      captured: null,
    };
  }

  if (YES.test(text) && !HEDGED.test(text)) {
    return {
      state: { kind: "confirmed", value: state.value },
      say: null,
      captured: state.value,
    };
  }

  // Neither agreement nor a value: the caller said something else entirely. Ask again
  // rather than guessing, and count it, so an unanswerable exchange still terminates.
  if (state.attempt >= MAX_SPOKEN_ATTEMPTS) return fallbackFor(state.subject);
  return {
    state: { kind: "confirming", value: state.value, attempt: state.attempt + 1, subject: state.subject },
    say: readback(state.value, state.subject, state.attempt + 1),
    captured: null,
  };
};

const onKeypad = (
  state: { readonly digits: string; readonly attempt: number },
  digit: string,
): CaptureResult => {
  if (digit === "#") {
    if (state.digits === "") {
      // Hash with nothing typed is a caller who cannot do this. Escalate rather than
      // loop; R6.4 wants a human after repeated failure, not another attempt.
      return { state: { kind: "escalate" }, say: escalation, captured: null };
    }
    // Keypad tones are unambiguous in a way speech is not, so there is nothing for a
    // readback to catch. R4.3.1 governs values captured from speech.
    return {
      state: { kind: "confirmed", value: state.digits },
      say: null,
      captured: state.digits,
    };
  }

  if (digit === "*") {
    return { state: { kind: "keypad", digits: "", attempt: state.attempt }, say: null, captured: null };
  }

  return {
    state: { kind: "keypad", digits: state.digits + digit, attempt: state.attempt },
    say: null,
    captured: null,
  };
};

export const advance = (state: CaptureState, event: CaptureEvent): CaptureResult => {
  if (state.kind === "confirmed" || state.kind === "escalate") {
    return { state, say: null, captured: null };
  }

  if (event.kind === "keypad") {
    if (state.kind !== "keypad") return { state, say: null, captured: null };
    return onKeypad(state, event.digit);
  }

  switch (state.kind) {
    case "idle":
      return start(event.text);
    case "confirming":
      return confirming(state, event.text);
    case "spelling":
      return spelling(state, event.text);
    case "keypad": {
      // Talking instead of typing. Repeat the instruction once, then hand over.
      if (state.attempt >= 1) {
        return { state: { kind: "escalate" }, say: escalation, captured: null };
      }
      return {
        state: { kind: "keypad", digits: state.digits, attempt: state.attempt + 1 },
        say: keypadPrompt,
        captured: null,
      };
    }
  }
};
