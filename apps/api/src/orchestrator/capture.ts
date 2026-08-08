import { forSpeech, parseSpokenDigits, sayReference } from "@ansa/normalizer";

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
export const MAX_SPOKEN_ATTEMPTS = 2;

export type CaptureState =
  | { readonly kind: "idle" }
  | { readonly kind: "confirming"; readonly value: string; readonly attempt: number }
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

const readback = (value: string): string =>
  forSpeech(`Let me read that back to you. ${sayReference(value)}. Is that correct?`);

const retry = forSpeech("Sorry, let's try again. Could you say it once more, slowly?");

const keypadPrompt = forSpeech(
  "Let's try the keypad instead. Please type it in now, then press the hash key.",
);

const escalation = forSpeech("Let me put you through to a colleague who can help with this.");

/** Begin a capture. The caller's turn is searched for a value; no value, no state change. */
const start = (text: string): CaptureResult => {
  const value = parseSpokenDigits(text);
  if (value === null) return { state: idle, say: null, captured: null };
  return {
    state: { kind: "confirming", value, attempt: 1 },
    say: readback(value),
    captured: null,
  };
};

const confirming = (
  state: { readonly value: string; readonly attempt: number },
  text: string,
): CaptureResult => {
  const said = parseSpokenDigits(text);

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
      state: { kind: "confirming", value: said, attempt: state.attempt + 1 },
      say: readback(said),
      captured: null,
    };
  }

  if (rejected) {
    if (state.attempt >= MAX_SPOKEN_ATTEMPTS) {
      return { state: { kind: "keypad", digits: "", attempt: 0 }, say: keypadPrompt, captured: null };
    }
    return {
      state: { kind: "confirming", value: state.value, attempt: state.attempt + 1 },
      say: retry,
      captured: null,
    };
  }

  if (YES.test(text)) {
    return {
      state: { kind: "confirmed", value: state.value },
      say: null,
      captured: state.value,
    };
  }

  // Neither agreement nor a value: the caller said something else entirely. Ask again
  // rather than guessing, and count it, so an unanswerable exchange still terminates.
  if (state.attempt >= MAX_SPOKEN_ATTEMPTS) {
    return { state: { kind: "keypad", digits: "", attempt: 0 }, say: keypadPrompt, captured: null };
  }
  return {
    state: { kind: "confirming", value: state.value, attempt: state.attempt + 1 },
    say: readback(state.value),
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
