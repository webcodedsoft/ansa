import {
  canonicalPhone,
  forSpeech,
  isClockTime,
  isEmail,
  isIsoDate,
  isNigerianMobile,
  parseBareAmount,
  parseSpelledName,
  parseSpokenAddress,
  parseSpokenAmount,
  parseSpokenDate,
  parseSpokenDayOfMonth,
  parseSpokenDigits,
  parseSpokenEmail,
  parseSpokenNumber,
  parseSpokenTime,
  sayAddress,
  sayAmount,
  sayDate,
  sayDigits,
  sayEmail,
  sayNumber,
  sayPhone,
  sayReference,
  sayTime,
  tidyAddress,
} from "@ansa/normalizer";

/**
 * Readback (R4.3.1).
 *
 * A number captured from speech is never usable until the caller has heard it back and
 * agreed. This is a state machine rather than a prompt instruction for the reason
 * CLAUDE.md gives: a prompt can be talked out of things and a dispatch path cannot. A
 * organization who writes "skip the readback, our customers find it slow" changes nothing
 * here, and neither does a caller who insists they already said it.
 *
 * There is deliberately no confidence threshold that skips the readback. Word confidence
 * on 8kHz telephony audio is not correctness — the transcriber has been confidently
 * wrong about "policy" on this very line — and a threshold would make the skip most
 * likely exactly when the line is worst.
 *
 * ## Risk-driven confirmation, and its hard edge
 *
 * Confirming every number a caller says is intolerable: "you have three policies, let me
 * read that back, three, is that correct?". So confirmation is driven by what the value
 * is *for*, which is what `EntityRisk` below encodes. But risk-driven cannot be allowed
 * to become confidence-driven, because those two arguments look alike and only one of
 * them is sound:
 *
 * - **Risk** is a property of the value. A policy number is a key into someone's record
 *   whether it was heard perfectly or not, so it is confirmed either way.
 * - **Confidence** is the transcriber's opinion of its own work on a channel that
 *   destroys the evidence. It is allowed to argue for *more* checking and is never
 *   consulted when deciding whether checking can be skipped.
 *
 * Concretely, the two functions that implement the policy are asymmetric on purpose:
 * `mustConfirm` cannot return false for anything with a risk of `identifier` or
 * `consequential`, and there is no code path in this file that reads a confidence score
 * on the way to a `false`. `spokenAttemptsFor` reads confidence and can only shorten the
 * road to a keypad or a spelling — that is, add checking.
 */

/** R4.3.3: the keypad is offered after two failed spoken attempts, not sooner. */
const MAX_SPOKEN_ATTEMPTS = 2;

/**
 * Below this, the transcriber is telling us it struggled and the caller gets a shorter
 * road to the keypad.
 *
 * **This number is a guess and is marked as one.** Nobody has measured what Deepgram or
 * OpenAI report on a real Nigerian line at 8kHz, and until the STT harness runs on a
 * genuine recording, tuning it would be tuning against an imagined distribution. It is
 * set high on purpose: the only thing a wrong value here can do is make the agent check
 * more often than it needed to, which is the failure this file is willing to have.
 */
const UNCERTAIN_BELOW = 0.7;

/**
 * Every structured value the agent captures.
 *
 * The identifier types are separate rather than one `reference` because their shapes are
 * knowable. A NIN is eleven digits; a ten-digit NIN is wrong before anyone reads it back,
 * and catching that in `problemWith` saves a whole confirm-reject-retry cycle on the one
 * kind of call where the caller is already impatient.
 */
export type EntityKind =
  | "name"
  | "reference"
  | "phone"
  | "email"
  | "address"
  | "date"
  | "time"
  | "amount"
  | "nin"
  | "bvn"
  | "otp"
  | "quantity";

/**
 * What it costs to get this value wrong, which is the only sound basis for deciding how
 * hard to check it.
 *
 * - `identifier` — the wrong value fetches the wrong record, or nobody's. R4.3.1 covers
 *   these absolutely: always read back, digit-exact, no threshold, no organization override.
 * - `consequential` — the wrong value produces the wrong action: money moved, a callback
 *   on the wrong day, a document to the wrong street. Also always read back, but as a
 *   sentence rather than a spell-out, because "forty-five thousand naira" is checkable
 *   by ear and "four five zero zero zero" is not.
 * - `conversational` — nothing acts on it. It is colour for the model: how many policies
 *   the caller has, roughly when something happened. Reading these back is what makes an
 *   agent feel like a form. This is the *only* tier that can skip confirmation, and it
 *   skips by not engaging capture at all — the value stays in the transcript and the
 *   model reads it there.
 */
export type EntityRisk = "identifier" | "consequential" | "conversational";

/**
 * Deliberately two values. There is no `"never"`, and adding one would be the change
 * that quietly repeals R4.3.1 — a organization config or a well-argued PR could then set it on
 * `phone` and nothing in the type system would object.
 */
export type ConfirmationRule = "always" | "when-uncertain";

/** Where a caller goes when speech has failed twice. */
export type CaptureFallback = "spelling" | "keypad" | "retry";

/**
 * What is being captured. It changes the fallback and the phrasing, not the flow: a
 * number the caller cannot get across goes to the keypad, and a name goes to spelling —
 * there is no key for "Sikiru".
 *
 * Kept as an alias because the orchestrator logs `capture.subject` and the field is
 * named for the thing rather than for this type.
 */
export type CaptureSubject = EntityKind;

export type CaptureState =
  | { readonly kind: "idle" }
  /**
   * The agent has asked for something specific and is waiting for it.
   *
   * Worth its own state because parsing is much better when it knows what it is looking
   * for. "The fourteenth" is a date only if something asked for one; in free speech it
   * is a fragment, and a date parser let loose on every turn would find dates in
   * "fourteen Adeola Odeku Street".
   */
  | { readonly kind: "awaiting"; readonly expect: EntityKind; readonly attempt: number }
  | {
      readonly kind: "confirming";
      readonly value: string;
      readonly attempt: number;
      readonly subject: EntityKind;
      /**
       * Every candidate heard for this entity, in order, including repeats.
       *
       * A single STT result is not evidence. Two independent results agreeing is much
       * stronger than one arriving loudly, so the value offered is the most-repeated
       * candidate rather than the most recent. It never skips the readback — R4.3.1 has
       * no confidence threshold and agreement is not correctness — it only decides which
       * value is worth putting to the caller.
       */
      readonly heard: readonly string[];
      /**
       * Values the caller has already said no to.
       *
       * On a live call the agent asked "TK — have I got that right?", was told no, and
       * asked "Sorry — TK. Is that right?". A rejected value is the one thing we know for
       * certain is wrong, and offering it again is worse than having no candidate at all.
       */
      readonly rejected: readonly string[];
      /** Attempts allowed before the fallback, shortened when the line sounded bad. */
      readonly allowed: number;
    }
  | {
      readonly kind: "spelling";
      readonly subject: EntityKind;
      readonly attempt: number;
      readonly rejected: readonly string[];
      /** The part of the value already known — for an email, the domain. */
      readonly context: string | null;
    }
  | {
      readonly kind: "keypad";
      readonly subject: EntityKind;
      readonly digits: string;
      readonly attempt: number;
    }
  | { readonly kind: "confirmed"; readonly value: string; readonly subject: EntityKind }
  | { readonly kind: "escalate" };

export type CaptureEvent =
  | {
      readonly kind: "speech";
      readonly text: string;
      /**
       * The transcriber's confidence, 0..1, or null/absent when it does not report one.
       *
       * Absent is not the same as low, and neither is permission to skip anything. The
       * only thing this value can do in this file is shorten the number of spoken
       * attempts before the keypad.
       */
      readonly confidence?: number | null;
      /** "Now", as epoch ms. Only dates need it; defaulted so existing call sites work. */
      readonly at?: number;
    }
  | { readonly kind: "keypad"; readonly digit: string };

export interface CaptureResult {
  readonly state: CaptureState;
  /** What the agent must say next, normalized. Null means the turn belongs to the LLM. */
  readonly say: string | null;
  /** Non-null only once confirmed. Nothing downstream may read a value before this. */
  readonly captured: string | null;
  /** What was captured, so the caller of this module can route it. Null until confirmed. */
  readonly capturedKind: EntityKind | null;
  /**
   * Whether capture has taken this turn.
   *
   * **This field exists because of a live call at 12:12:42 on 2026-08-08 where the agent
   * went permanently silent.** The orchestrator treated "capture ran" as "capture
   * handled it" and never let the model answer. Once the state reached `escalate`,
   * `advance` returned the state unchanged with nothing to say, the orchestrator still
   * reported the turn as handled, and the caller — who had just been told "let me get a
   * colleague for you" — talked to a dead line until they hung up.
   *
   * `say === null` was not a usable substitute for this, because it is also null on the
   * turn where a value is confirmed, which capture very much has handled. The two
   * questions are different and now they have different fields.
   *
   * False means: this module is not involved in this turn, release it to the model.
   * `escalate` is terminal for *capture* and must not be terminal for the *call*.
   */
  readonly handled: boolean;
}

export const idle: CaptureState = { kind: "idle" };

/**
 * Capture is not involved in this turn — nothing to capture, or capture is over.
 *
 * The state is returned unchanged so an escalation stays escalated: a caller who has
 * failed three times is not dragged back into a readback loop by their next sentence.
 * They are simply heard by the model like any other caller.
 */
const released = (state: CaptureState): CaptureResult => ({
  state,
  say: null,
  captured: null,
  capturedKind: null,
  handled: false,
});

/** Capture holds the turn and has nothing to say this time — mid keypad entry. */
const silent = (state: CaptureState): CaptureResult => ({
  state,
  say: null,
  captured: null,
  capturedKind: null,
  handled: true,
});

/* ------------------------------------------------------------- recognisers */

/** How a caller introduces themselves. Deliberately explicit forms only. */
const NAME_CUE = /\b(?:my name is|my name's|the name is|i am called|i'm called|call me)\s+(.*)$/i;

/**
 * English function words, which a name is never one of.
 *
 * This is a list of grammar, not a list of names — there is no way to enumerate names
 * and no attempt is made to. It exists because "call me" is both an introduction and the
 * front of "call me on oh eight one three…": a name cue followed immediately by a
 * preposition or an adverb is not an introduction, and without this the agent read a
 * caller's phone number back to them as their name.
 */
const FUNCTION_WORD =
  /^(on|at|in|back|later|again|now|when|if|about|after|before|around|by|from|to|the|a|an|please|soon|tomorrow|today|tonight|anytime|whenever)$/i;

/**
 * The name in a caller's turn, if they gave one.
 *
 * Matched against a single sentence rather than the whole turn: "My name is Hill. How
 * are you doing?" must yield "Hill", not "Hill How are you doing".
 */
const nameFrom = (text: string): string | null => {
  for (const sentence of text.split(/[.?!,]+/)) {
    const match = NAME_CUE.exec(sentence.trim());
    if (match === null) continue;

    const rest = (match[1] ?? "").trim();
    // Unicode letters, not A-Z. A transcriber that emits a name with its diacritics
    // intact was having the whole name discarded by an ASCII class, which is the one
    // failure mode this file exists to avoid.
    //
    // Three words, not two. Two truncates a particled or three-part name — a great many
    // Iberian, Dutch, Arabic and South Asian names are three words and the caller has
    // then given a name the agent cannot repeat. Three is still a cap: beyond it, it is
    // the transcriber running on rather than a longer name, and the readback catches
    // over-capture in a way it cannot catch truncation.
    const words = rest
      .split(/\s+/)
      .filter((w) => /^\p{L}[\p{L}'-]*$/u.test(w))
      .slice(0, 3);
    const first = words[0];
    if (first === undefined || FUNCTION_WORD.test(first)) continue;
    return words.filter((w) => !FUNCTION_WORD.test(w)).join(" ");
  }
  return null;
};

/**
 * Turns that are a conversational move rather than an answer — used only when a name was
 * asked for.
 *
 * Also grammar, not names: these are the English words a caller uses to say "pardon?" or
 * "hello", and a bare-name parse must not turn one of them into somebody's name.
 */
const NOT_A_NAME = /\b(yes|yeah|no|nope|sorry|hello|hi|what|pardon|okay|thanks|thank)\b/i;

/**
 * A bare name, for when the agent has just asked "and your name?" and the answer is one
 * word with no cue in front of it. Never used on an unprompted turn: every second
 * sentence in English would parse as a name.
 */
const bareName = (text: string): string | null => {
  const cued = nameFrom(text);
  if (cued !== null) return cued;
  if (NOT_A_NAME.test(text)) return null;

  const words = text
    .trim()
    .split(/[\s,]+/)
    .filter((w) => /^\p{L}[\p{L}'-]+$/u.test(w));
  if (words.length === 0 || words.length > 3) return null;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
};

const digitsOf = (text: string): string | null => parseSpokenDigits(text);

/**
 * Extract, do not judge.
 *
 * Returns the digits even when they do not canonicalise, so a caller who said "my phone
 * number is" and got half of it across is told what is wrong with it. Returning null
 * instead sent the value down the shape fallback and had a six-digit fragment confirmed
 * as a policy number. Validation belongs in `problem`, which is where the caller hears
 * about it.
 */
const phoneFrom = (text: string): string | null => {
  const digits = parseSpokenDigits(text);
  if (digits === null) return null;
  return canonicalPhone(digits) ?? digits;
};

const elevenDigits = (text: string): string | null => {
  const digits = parseSpokenDigits(text);
  return digits === null ? null : digits.replace(/\D/g, "");
};

const amountString = (naira: number | null): string | null =>
  naira === null ? null : String(naira);

/* --------------------------------------------------------- the policy table */

interface EntityPolicy {
  readonly risk: EntityRisk;
  readonly confirm: ConfirmationRule;
  readonly fallback: CaptureFallback;
  /** Never written to a log, an event, or the model's context in the clear. */
  readonly sensitive: boolean;
  /** How the agent refers to it: "your policy number". */
  readonly label: string;
  /** How the agent asks for it. */
  readonly ask: string;
  /** From a turn the caller volunteered. */
  readonly parse: (text: string, atMs: number) => string | null;
  /** From a turn answering a direct question. Defaults to `parse`. */
  readonly parseDirected?: (text: string, atMs: number) => string | null;
  /** Read back through the normalizer (R4.3.2). */
  readonly say: (value: string, atMs: number) => string;
  /** Null when the shape is fine; otherwise what the agent says about it. */
  readonly problem: (value: string) => string | null;
}

const digitCount = (value: string, expected: number, name: string): string | null => {
  const digits = value.replace(/\D/g, "");
  if (digits.length === expected) return null;
  // Said before the readback, so the caller is not asked to confirm something already
  // known to be wrong. Counting the digits out loud is also how they realise which one
  // the transcriber dropped.
  return `That came to ${sayNumber(digits.length)} digits — ${name} has ${sayNumber(expected)}.`;
};

/**
 * Risk, confirmation rule, capture mode and normalizer path for every entity, in one
 * table so that adding a kind means filling in a row rather than finding six switches.
 */
export const ENTITY_POLICY: Readonly<Record<EntityKind, EntityPolicy>> = {
  /**
   * Identifier. Nigerian names cannot be transcribed reliably at 8kHz and keyterms
   * cannot help — a caller's name is unknown by definition, so there is nothing to
   * boost. Confirming is the only way to discover we heard it wrong, and spelling is the
   * only fallback that converges.
   */
  name: {
    risk: "identifier",
    confirm: "always",
    fallback: "spelling",
    sensitive: false,
    label: "your name",
    ask: "And your name?",
    parse: (text) => nameFrom(text),
    parseDirected: (text) => bareName(text),
    say: (value) => value,
    problem: (value) => (value.trim().length >= 2 ? null : "Sorry, I only caught part of that."),
  },

  /**
   * Identifier. Policy, claim, account, certificate — shape unknown by design, because
   * every organization numbers their records differently and validating against a guess would
   * reject the ones we have not seen.
   */
  reference: {
    risk: "identifier",
    confirm: "always",
    fallback: "keypad",
    sensitive: false,
    label: "that number",
    ask: "What's the number?",
    parse: (text) => digitsOf(text),
    // Some organizations number records with letters and no digits at all. A run of single
    // letters cannot be recognised as a value in free speech — every sentence would
    // qualify — but in answer to "what's the number?" it is unambiguous.
    parseDirected: (text) => digitsOf(text) ?? parseSpelledName(text, 2)?.toUpperCase() ?? null,
    say: (value) => sayReference(value),
    problem: (value) => (value.length >= 3 ? null : "That sounded short — can I have the whole thing?"),
  },

  /**
   * Identifier, and the one whose failure is silent. A wrong policy number produces "I
   * can't find that" while the caller is still on the line; a wrong phone number
   * produces a callback that never arrives and a complaint a week later.
   */
  phone: {
    risk: "identifier",
    confirm: "always",
    fallback: "keypad",
    sensitive: false,
    label: "your number",
    ask: "What's the best number to reach you on?",
    parse: (text) => phoneFrom(text),
    say: (value) => sayPhone(value),
    problem: (value) =>
      isNigerianMobile(value) ? null : "That doesn't look like a complete mobile number.",
  },

  /**
   * Identifier. One wrong character delivers to a stranger, so the readback spells the
   * local part rather than saying it — see `sayEmail`.
   */
  email: {
    risk: "identifier",
    confirm: "always",
    fallback: "spelling",
    sensitive: false,
    label: "your email",
    ask: "What's your email address?",
    parse: (text) => parseSpokenEmail(text),
    say: (value) => sayEmail(value),
    problem: (value) => (isEmail(value) ? null : "I didn't get the whole address."),
  },

  /**
   * Consequential. Not an identifier — nothing is looked up by it — but a document or an
   * assessor sent to the wrong street is a wasted day for somebody. Read back as the
   * caller said it, because an address is checked by ear one line at a time.
   */
  address: {
    risk: "consequential",
    confirm: "always",
    fallback: "retry",
    sensitive: false,
    label: "the address",
    ask: "What's the address?",
    parse: (text) => parseSpokenAddress(text),
    parseDirected: (text) => tidyAddress(text),
    say: (value) => sayAddress(value),
    problem: (value) =>
      value.split(/\s+/).length >= 3 ? null : "Sorry, I only caught part of the address.",
  },

  /**
   * Consequential. A callback booked for the wrong Tuesday is a missed callback, and
   * nobody finds out until the day. The readback says the weekday the caller never gave,
   * which is the only checksum available for a date.
   */
  date: {
    risk: "consequential",
    confirm: "always",
    fallback: "retry",
    sensitive: false,
    label: "the date",
    ask: "What day suits you?",
    parse: (text, atMs) => parseSpokenDate(text, atMs),
    parseDirected: (text, atMs) =>
      parseSpokenDate(text, atMs) ?? parseSpokenDayOfMonth(text, atMs),
    say: (value, atMs) => sayDate(value, atMs),
    problem: (value) => (isIsoDate(value) ? null : "I didn't catch the date."),
  },

  /**
   * Consequential. The am/pm is guessed when the caller does not say it, so the readback
   * says which way it guessed — "two o'clock in the afternoon".
   */
  time: {
    risk: "consequential",
    confirm: "always",
    fallback: "retry",
    sensitive: false,
    label: "the time",
    ask: "What time works for you?",
    parse: (text) => parseSpokenTime(text),
    say: (value) => sayTime(value),
    problem: (value) => (isClockTime(value) ? null : "I didn't catch the time."),
  },

  /**
   * Consequential, and the highest-stakes thing the agent says out loud. A misheard
   * premium is a complaint; a misspoken one is a dispute. Said as words rather than
   * digits because "forty-five thousand naira" is checkable by ear and "four five oh oh
   * oh" is not.
   */
  amount: {
    risk: "consequential",
    confirm: "always",
    fallback: "keypad",
    sensitive: false,
    label: "the amount",
    ask: "How much is it?",
    parse: (text) => amountString(parseSpokenAmount(text)),
    parseDirected: (text) => amountString(parseBareAmount(text)),
    say: (value) => sayAmount(Number(value)),
    problem: (value) => (Number.isFinite(Number(value)) ? null : "I didn't catch the amount."),
  },

  /** Identifier, eleven digits, and the length is checkable before the readback. */
  nin: {
    risk: "identifier",
    confirm: "always",
    fallback: "keypad",
    sensitive: true,
    label: "your N I N",
    ask: "What's your N I N?",
    parse: (text) => elevenDigits(text),
    say: (value) => sayDigits(value),
    problem: (value) => digitCount(value, 11, "a N I N"),
  },

  /** Identifier, eleven digits, same as the NIN and just as checkable. */
  bvn: {
    risk: "identifier",
    confirm: "always",
    fallback: "keypad",
    sensitive: true,
    label: "your B V N",
    ask: "What's your B V N?",
    parse: (text) => elevenDigits(text),
    say: (value) => sayDigits(value),
    problem: (value) => digitCount(value, 11, "a B V N"),
  },

  /**
   * Identifier, and the most sensitive value on the call. Never logged, never put in the
   * model's context — see `logSafe`. Confirmed like everything else: a caller reading a
   * code off a screen is exactly the situation where one digit goes missing.
   */
  otp: {
    risk: "identifier",
    confirm: "always",
    fallback: "keypad",
    sensitive: true,
    label: "the code",
    ask: "What's the code?",
    parse: (text) => elevenDigits(text),
    say: (value) => sayDigits(value),
    problem: (value) =>
      /^\d{4,8}$/.test(value) ? null : "A code is usually four to eight digits — I may have missed one.",
  },

  /**
   * Conversational, and the reason this table exists.
   *
   * "I have three policies", "I've been with you since 2019". Nothing looks anything up
   * by these and nothing acts on them; the old shape rule confirmed the second one
   * because it was four characters long, and reading a year back to a caller is what
   * turns a conversation into a form. Capture does not engage — the model reads the
   * value out of the transcript like any other fact.
   *
   * The exception is the whole point of `when-uncertain`: if the transcriber says it
   * struggled, the value is worth a question after all. Confidence adding a check is
   * always allowed; confidence removing one never is.
   */
  quantity: {
    risk: "conversational",
    confirm: "when-uncertain",
    fallback: "retry",
    sensitive: false,
    label: "that",
    ask: "Sorry, how many was that?",
    parse: (text) => {
      const value = parseSpokenNumber(text);
      return value === null ? null : String(value);
    },
    say: (value) => sayNumber(Number(value)),
    problem: () => null,
  },
};

/* ------------------------------------------------------ the confirmation rule */

/**
 * Whether this value has to be read back before anything may use it.
 *
 * Read the shape of this function, not just its result. The `always` branch returns
 * `true` before `confidence` is in scope for any decision, so there is no arrangement of
 * inputs — a organization setting, a high score, a caller insisting — that reaches a `false`
 * for an identifier or a consequential value. That is R4.3.1 expressed as control flow
 * rather than as a rule someone has to remember.
 *
 * The `when-uncertain` branch is the only one that reads confidence, and it reads it in
 * the direction that adds a question.
 */
export const mustConfirm = (
  kind: EntityKind,
  value: string,
  confidence?: number | null,
): boolean => {
  const policy = ENTITY_POLICY[kind];
  if (policy.confirm === "always") return true;

  // Conversational, so it only earns a question if something is actually wrong with it:
  // the transcriber reported a poor result, or the value does not fit its own shape.
  if (policy.problem(value) !== null) return true;
  return typeof confidence === "number" && confidence < UNCERTAIN_BELOW;
};

/**
 * How many spoken attempts before the keypad or the spelling.
 *
 * Confidence is allowed here because it can only make the number smaller. A caller whose
 * line the transcriber is struggling with gets to the keypad sooner instead of being
 * asked to repeat themselves into the same noise twice.
 */
export const spokenAttemptsFor = (kind: EntityKind, confidence?: number | null): number => {
  const uncertain = typeof confidence === "number" && confidence < UNCERTAIN_BELOW;
  // Only shorten when there is somewhere better to go. A date has no keypad and no
  // spelling, so cutting its spoken attempts short does not add checking — it just
  // reaches the escalation sooner, and hanging up on a caller who was one repetition
  // away from being understood is not "more checking".
  const hasFallback = ENTITY_POLICY[kind].fallback !== "retry";
  // Never more than MAX_SPOKEN_ATTEMPTS, and never fewer than one — a value has to be
  // put to the caller at least once, or the readback has not happened.
  return uncertain && hasFallback ? 1 : MAX_SPOKEN_ATTEMPTS;
};

/**
 * A value as it may appear in a log, an event or the model's context.
 *
 * A NIN, a BVN and a one-time code are all things a caller reads aloud that must not
 * survive the call in the clear. The orchestrator logs the candidate value on every
 * `entity_candidate` event, so without this the transcript viewer becomes a list of
 * national identity numbers.
 */
export const logSafe = (kind: EntityKind, value: string): string =>
  ENTITY_POLICY[kind].sensitive ? `«${kind}:${value.length} chars»` : value;

/**
 * What the model is told once a value is confirmed. Never called before that.
 *
 * Phrased as the caller's own words because it is inserted into the conversation as a
 * caller turn: the model must see a fact it can use, not a system note it might read
 * aloud.
 */
export const confirmedUtterance = (kind: EntityKind, value: string): string => {
  switch (kind) {
    case "name":
      return `Yes, that is right. My name is ${value}.`;
    case "email":
      return `Yes, that is correct. My email is ${value}.`;
    case "address":
      return `Yes, that is correct. The address is ${value}.`;
    case "date":
      return `Yes, that is correct. The date is ${value}.`;
    case "time":
      return `Yes, that is correct. The time is ${value}.`;
    case "amount":
      return `Yes, that is correct. The amount is ₦${value}.`;
    case "phone":
      return `Yes, that is correct. My phone number is ${value}.`;
    default:
      return `Yes, that is correct. My ${ENTITY_POLICY[kind].label.replace(/^your /, "")} is ${value}.`;
  }
};

/* ------------------------------------------------------------ classification */

/**
 * Cue words that name the entity outright, most specific first.
 *
 * Order is the whole design here. "What's my policy number" and "the OTP number" both
 * contain "number", so the specific identifier has to be tested before the generic one,
 * or every code in the product becomes a reference.
 */
const CUES: readonly (readonly [EntityKind, RegExp])[] = [
  ["otp", /\b(o\.?t\.?p|one[- ]?time (?:code|password|pin)|passcode|pass code|\bpin\b|the code (?:you|they) sent)\b/i],
  ["nin", /\bn\.?i\.?n\b|\bnational identi/i],
  ["bvn", /\bb\.?v\.?n\b|\bbank verification/i],
  ["email", /\be-?mail\b|@/i],
  ["phone", /\b(phone|mobile|whatsapp|call me on|reach me on|number to call|my line)\b/i],
  ["address", /\b(address|deliver|delivery|i live at|send it to|post it to)\b/i],
  ["amount", /₦|\bnaira\b|\bngn\b/i],
  ["time", /\b(o'?clock|a\.?m\.?|p\.?m\.?|half past|quarter (?:past|to)|what time|at what time)\b/i],
  ["date", /\b(tomorrow|today|next week|on (?:mon|tues|wednes|thurs|fri|satur|sun)day|what day|book|schedule|appointment|call me back)\b/i],
  ["reference", /\b(policy|claim|reference|ref|account|acct|certificate)\b/i],
];

/**
 * Framing that makes a number a measurement rather than a value being dictated.
 *
 * Counting words, hedges and time prepositions — grammar, not values. A caller who says
 * "I have", "about", "since" or "for the last" before a number is telling you how much
 * or how long, and neither is something to read back. A caller dictating an identifier
 * does not hedge it.
 */
const QUANTIFIED =
  /\b(i have|i've|we have|we've|there are|there were|it'?s been|been|about|around|roughly|approximately|nearly|almost|over|under|more than|less than|at least|since|for the (?:last|past)|only|just|maybe|some)\b/i;

/**
 * Which entity the caller just gave, or null when the turn holds nothing to capture.
 *
 * Cues first, shape second. A cue is what the caller said the value *is*, and it beats
 * any inference from the digits: "my policy number is oh eight one three eight one seven
 * eight five five oh" is a policy number that happens to look like a phone number, and
 * guessing phone from the shape would file it in the wrong field.
 */
export const classify = (text: string, atMs: number): EntityKind | null => {
  // A name is looked for first, and it wins over a number in the same turn. When a
  // caller gives both, who they are is the thing the transcriber is worse at.
  if (nameFrom(text) !== null) return "name";

  for (const [kind, cue] of CUES) {
    if (!cue.test(text)) continue;
    // A cue with nothing behind it is a caller talking *about* the thing — "I've lost my
    // policy number" — so the kind only holds if the value is actually there.
    if (ENTITY_POLICY[kind].parse(text, atMs) !== null) return kind;
  }

  const digits = parseSpokenDigits(text);
  if (digits === null) return null;

  // Framed as a measurement rather than dictated as a value. "I've been with you since
  // 2019" is four characters long and the old shape rule confirmed it on that basis
  // alone, which is a year read back at a caller who was making conversation. This is
  // conversational context, not the value: the same digits after "my policy number is"
  // are still a reference.
  if (QUANTIFIED.test(text)) return "quantity";

  // Shape fallbacks, for a value given with no cue and no framing at all.
  if (canonicalPhone(digits) !== null) return "phone";
  // A letter, a leading zero, or four or more characters is a reference by shape.
  if (/[A-Z]/.test(digits) || digits.startsWith("0") || digits.length >= 4) return "reference";

  // Everything else is a number in a sentence: "I have three policies".
  return "quantity";
};

/*
 * `worthConfirming` lived here and has been deleted along with the orchestrator gate it
 * served. That gate asked "is this turn worth engaging capture for" *before* capture was
 * consulted, which meant the answer had to be derived from a digit parse the orchestrator
 * did itself — and so email, address, date, time and amount were unreachable however
 * clearly the caller said them. `advance` now classifies its own turn and answers the same
 * question on `CaptureResult.handled`, from the parsed value rather than from a guess at
 * it. Two answers to one question is how they drift apart.
 */

/* ------------------------------------------------------------------ speaking */

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
 * Did the caller say yes, and mean it?
 *
 * Exported because a spoken confirmation is not only a readback's business any more: a
 * write-tier tool is read back and then fired on a yes (R5.3), and that yes has to be
 * judged by the same rules as this one. Two definitions of agreement in a codebase is one
 * of them being wrong about "yeah, but…".
 *
 * All three clauses matter and each was earned. A hedge or a question is not agreement.
 * A turn containing a rejection is not agreement even when it also contains "yes" —
 * "yes, no, that's wrong" is a correction. And "no wahala" is agreement, so the Nigerian
 * false negatives come out before the rejection is tested.
 *
 * `text` is the caller's turn as spoken; both patterns are case-insensitive.
 */
export const isAffirmative = (text: string): boolean =>
  YES.test(text) && !HEDGED.test(text) && !NO.test(text.replace(FALSE_NEGATIVES, " "));

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
 *
 * The phrasing splits on risk, not on kind. An identifier is *read back* — the words
 * signal that the agent is checking a value character by character. A consequential
 * value is repeated as a sentence, because "the fourteenth of August, is that right?" is
 * how a person confirms a date and "let me read that back" is not.
 */
const readback = (
  value: string,
  subject: EntityKind,
  attempt: number,
  atMs: number,
): string => {
  const policy = ENTITY_POLICY[subject];
  const spoken = policy.say(value, atMs);

  if (attempt > 1) {
    // Second time of asking. Shorter, and it acknowledges that it is the second time.
    return forSpeech(`Sorry — ${spoken}. Is that right?`);
  }
  if (subject === "name") return forSpeech(`${spoken} — have I got that right?`);
  if (policy.risk === "identifier") {
    return forSpeech(`Let me read that back — ${spoken}. Is that right?`);
  }
  return forSpeech(`${spoken} — is that right?`);
};

/**
 * Asks for a spelling, and only explains how on the second attempt.
 *
 * Leading with the full instruction is what produced the seven-second monologue. Most
 * callers just spell it; the ones who need the hint get it when they need it.
 */
const spellPromptFor = (attempt: number, subject: EntityKind): string => {
  // An email is spelled in two halves and only the first one is hard. Asking for the
  // whole address letter by letter, "G, M, A, I, L", is what makes callers give up.
  const what = subject === "email" ? "the part before the at" : "it";
  return attempt <= 0
    ? forSpeech(`Sorry about that. Could you spell ${what} for me?`)
    // B, C, D, E, G, P, T, V, Z and J all rhyme, and 8kHz strips the high-frequency
    // detail that separates them, so bare letters are what this channel is worst at. A
    // word per letter replaces a one-phoneme distinction with a whole-word one.
    : forSpeech("Take it slowly for me — a word for each letter, like A for Abuja.");
};

const keypadPrompt = forSpeech("Could you type it on your keypad, then press hash?");

/** Asking again after a rejection. Short, because they already know what we want. */
const retryPrompt = forSpeech("Sorry — once more, slowly?");

const escalation = forSpeech("Let me get a colleague for you.");

const escalate = (): CaptureResult => ({
  state: { kind: "escalate" },
  say: escalation,
  captured: null,
  capturedKind: null,
  handled: true,
});

/* ------------------------------------------------------------ the machine */

/**
 * The candidate worth offering: most agreed-upon first, never one already rejected.
 *
 * This is the whole answer to "do not trust a single STT result". Nothing here decides a
 * value is correct — only which of several guesses to put to the caller next.
 */
const bestCandidate = (
  heard: readonly string[],
  rejected: readonly string[],
): string | null => {
  const counts = new Map<string, number>();
  for (const value of heard) {
    if (rejected.includes(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    // Ties go to the earlier candidate: the caller said it first and has not corrected it.
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
};

/** Begin a capture of a value that has already been decided worth confirming. */
const beginCapture = (
  value: string,
  subject: EntityKind,
  atMs: number,
  confidence?: number | null,
  rejected: readonly string[] = [],
): CaptureResult => {
  // A value that does not fit its own shape is not put to the caller as a question. "Is
  // that right?" on nine digits of an eleven-digit NIN wastes a whole exchange on
  // something already known to be wrong.
  const problem = ENTITY_POLICY[subject].problem(value);
  if (problem !== null) {
    return {
      state: { kind: "awaiting", expect: subject, attempt: 1 },
      say: forSpeech(`${problem} ${ENTITY_POLICY[subject].ask}`),
      captured: null,
      capturedKind: null,
      handled: true,
    };
  }

  return {
    state: {
      kind: "confirming",
      value,
      attempt: 1,
      subject,
      heard: [value],
      rejected,
      allowed: spokenAttemptsFor(subject, confidence),
    },
    say: readback(value, subject, 1, atMs),
    captured: null,
    capturedKind: null,
    handled: true,
  };
};

/**
 * Begin a capture. The caller's turn is classified; nothing worth capturing, no state
 * change and the turn belongs to the model.
 */
const start = (text: string, atMs: number, confidence?: number | null): CaptureResult => {
  const kind = classify(text, atMs);
  if (kind === null) return released(idle);

  const value = ENTITY_POLICY[kind].parse(text, atMs);
  if (value === null) return released(idle);

  // The risk-driven skip, and the only one. A conversational value is left in the
  // transcript for the model rather than read back at the caller. Released rather than
  // swallowed: the turn still needs an answer, and it is the model's to give.
  if (!mustConfirm(kind, value, confidence)) return released(idle);

  return beginCapture(value, kind, atMs, confidence);
};

/** Where a caller goes when speech has failed twice. */
const fallbackFor = (
  subject: EntityKind,
  rejected: readonly string[],
  context: string | null = null,
): CaptureResult => {
  switch (ENTITY_POLICY[subject].fallback) {
    case "spelling":
      return {
        state: { kind: "spelling", subject, attempt: 0, rejected, context },
        say: spellPromptFor(0, subject),
        captured: null,
        capturedKind: null,
        handled: true,
      };
    case "keypad":
      return {
        state: { kind: "keypad", subject, digits: "", attempt: 0 },
        say: keypadPrompt,
        captured: null,
        capturedKind: null,
        handled: true,
      };
    case "retry":
      // Nothing to fall back *to*: an address cannot be typed on a keypad and a date
      // cannot be spelled. R6.4 wants a human after repeated failure, not another loop.
      return escalate();
  }
};

/** The domain half of whatever email was last heard, so a spelling can rebuild the address. */
const domainOf = (value: string): string | null => {
  const at = value.indexOf("@");
  return at === -1 ? null : value.slice(at + 1);
};

const spelling = (
  state: {
    readonly subject: EntityKind;
    readonly attempt: number;
    readonly rejected: readonly string[];
    readonly context: string | null;
  },
  text: string,
  atMs: number,
): CaptureResult => {
  // Two letters is enough here and not in free speech: something has just asked the
  // caller to spell, so this is a spelling. Two-letter surnames are real in several
  // naming traditions and a three-letter floor means those callers can never get their
  // name across at all. The discourse guard is what the floor used to buy — "OK" in
  // answer to "could you spell it?" is agreement, not a name.
  const letters = NOT_A_NAME.test(text) ? null : parseSpelledName(text, 2);
  // An email spelled out is only the local part; the domain is the half the caller got
  // across the first time and does not need spelling.
  const spelled =
    state.subject !== "email" ? letters
    : letters === null ? parseSpokenEmail(text)
    : state.context === null ? null
    : `${letters.toLowerCase()}@${state.context}`;

  // A spelling that reproduces something already rejected is not a correction, and
  // offering it back would restart the loop the caller is trying to escape.
  if (spelled !== null && !state.rejected.includes(spelled)) {
    return beginCapture(spelled, state.subject, atMs, null, state.rejected);
  }

  // They answered something other than a spelling. Ask once more, then hand over.
  if (state.attempt >= 1) return escalate();
  return {
    state: { ...state, kind: "spelling", attempt: state.attempt + 1 },
    say: spellPromptFor(state.attempt + 1, state.subject),
    captured: null,
    capturedKind: null,
    handled: true,
  };
};

/**
 * Re-parse a caller's turn while a value of the same kind is under confirmation.
 *
 * Parsed for names as well as numbers now. The previous rule refused to re-read a name
 * from free speech at all, to stop a third wrong spelling — and it threw away a genuine
 * correction: the caller answered "TK — have I got that right?" with "My name is Kim
 * Woo", a new candidate, and the agent asked about TK again. The narrower rule that
 * actually holds is elsewhere in this file: never offer a value the caller has already
 * rejected.
 */
const reparse = (subject: EntityKind, text: string, atMs: number): string | null =>
  ENTITY_POLICY[subject].parse(text, atMs);

/**
 * The lenient parse, used only from `awaiting` — when the agent has just asked and the
 * answer can be nothing else.
 *
 * Kept apart from `reparse` on purpose. The lenient address parser accepts any three
 * words as an address, and running it during confirmation read "Yes, that is correct"
 * back to the caller as their street.
 */
const parseAnswer = (subject: EntityKind, text: string, atMs: number): string | null => {
  const policy = ENTITY_POLICY[subject];
  return (policy.parseDirected ?? policy.parse)(text, atMs);
};

const confirming = (
  state: {
    readonly value: string;
    readonly attempt: number;
    readonly subject: EntityKind;
    readonly heard: readonly string[];
    readonly rejected: readonly string[];
    readonly allowed: number;
  },
  text: string,
  atMs: number,
): CaptureResult => {
  const said = reparse(state.subject, text, atMs);
  const rejected = NO.test(text.replace(FALSE_NEGATIVES, " "));

  // Rejection first, so the value being rejected is recorded before anything replaces it.
  const rejectedNow = rejected ? [...state.rejected, state.value] : state.rejected;

  // Order matters. A caller correcting usually says "no, it's four one eight" — rejection
  // and correction in one breath. Taking the number first would accept it silently;
  // stopping at "no" would throw it away.
  const heard =
    said !== null && !rejectedNow.includes(said) ? [...state.heard, said] : state.heard;

  // A correction the caller just spoke breaks ties in its own favour: they said it
  // most recently and deliberately. Repetition still wins outright, so two agreeing
  // results beat one fresh one — but one fresh one beats a stale tie, which is what
  // "my name is Kim Woo" was and what the earlier-wins rule threw away.
  const agreed = bestCandidate(heard, rejectedNow);
  const timesHeard = (value: string | null): number =>
    value === null ? -1 : heard.filter((h) => h === value && !rejectedNow.includes(h)).length;
  const next =
    said !== null && !rejectedNow.includes(said) && timesHeard(said) >= timesHeard(agreed)
      ? said
      : agreed;

  const context = state.subject === "email" ? domainOf(state.value) : null;

  if (rejected || (said !== null && said !== state.value)) {
    if (next === null || next === state.value) {
      // Nothing left worth offering. Asking again with the same value is what the caller
      // is already tired of, so hand over to spelling or the keypad instead.
      if (ENTITY_POLICY[state.subject].fallback === "spelling" || state.attempt >= state.allowed) {
        return fallbackFor(state.subject, rejectedNow, context);
      }
      return {
        state: { ...state, kind: "confirming", attempt: state.attempt + 1, heard, rejected: rejectedNow },
        say: retryPrompt,
        captured: null,
        capturedKind: null,
        handled: true,
      };
    }

    // A different value, whether or not "no" was said, is a correction. It is read back
    // rather than trusted: a correction is speech too, and R4.3.1 does not exempt it.
    return {
      state: {
        kind: "confirming",
        value: next,
        attempt: state.attempt + 1,
        subject: state.subject,
        heard,
        rejected: rejectedNow,
        allowed: state.allowed,
      },
      say: readback(next, state.subject, 1, atMs),
      captured: null,
      capturedKind: null,
      handled: true,
    };
  }

  // The rejection branch above has already returned, so the "and not a no" clause inside
  // isAffirmative is a no-op here. Called anyway, so there is one definition of yes.
  if (isAffirmative(text)) {
    return {
      state: { kind: "confirmed", value: state.value, subject: state.subject },
      say: null,
      captured: state.value,
      capturedKind: state.subject,
      handled: true,
    };
  }

  // Neither agreement nor a new value. Ask again — but with the best candidate we hold,
  // which repetition may have changed under us, and never with a rejected one.
  if (state.attempt >= state.allowed) return fallbackFor(state.subject, rejectedNow, context);
  const offer = next ?? state.value;
  return {
    state: {
      kind: "confirming",
      value: offer,
      attempt: state.attempt + 1,
      subject: state.subject,
      heard,
      rejected: rejectedNow,
      allowed: state.allowed,
    },
    say: readback(offer, state.subject, offer === state.value ? state.attempt + 1 : 1, atMs),
    captured: null,
    capturedKind: null,
    handled: true,
  };
};

/**
 * The agent asked for something and the caller answered.
 *
 * Parsing is targeted at the kind that was asked for, which is the only reason a date or
 * a bare name can be read at all: "the fourteenth" and "Sikiru" are not recognisable as
 * values in free speech, and are unambiguous in answer to a question.
 */
const awaiting = (
  state: { readonly expect: EntityKind; readonly attempt: number },
  text: string,
  atMs: number,
  confidence?: number | null,
): CaptureResult => {
  const value = parseAnswer(state.expect, text, atMs);
  if (value !== null) return beginCapture(value, state.expect, atMs, confidence);

  if (state.attempt >= spokenAttemptsFor(state.expect, confidence)) {
    return fallbackFor(state.expect, []);
  }
  return {
    state: { kind: "awaiting", expect: state.expect, attempt: state.attempt + 1 },
    say: forSpeech(`Sorry — ${ENTITY_POLICY[state.expect].ask}`),
    captured: null,
    capturedKind: null,
    handled: true,
  };
};

const onKeypad = (
  state: { readonly subject: EntityKind; readonly digits: string; readonly attempt: number },
  digit: string,
): CaptureResult => {
  if (digit === "#") {
    if (state.digits === "") {
      // Hash with nothing typed is a caller who cannot do this. Escalate rather than
      // loop; R6.4 wants a human after repeated failure, not another attempt.
      return escalate();
    }

    // Keypad tones are unambiguous in a way speech is not, so there is nothing for a
    // readback to catch. R4.3.1 governs values captured from speech.
    //
    // The shape check still applies, because a caller can type nine digits of an
    // eleven-digit BVN perfectly clearly. That is a different failure from mishearing
    // and the keypad does not fix it.
    const problem = ENTITY_POLICY[state.subject].problem(state.digits);
    if (problem !== null) {
      if (state.attempt >= 1) return escalate();
      return {
        state: { kind: "keypad", subject: state.subject, digits: "", attempt: state.attempt + 1 },
        say: forSpeech(`${problem} Could you type it again, then press hash?`),
        captured: null,
        capturedKind: null,
        handled: true,
      };
    }

    return {
      state: { kind: "confirmed", value: state.digits, subject: state.subject },
      say: null,
      captured: state.digits,
      capturedKind: state.subject,
      handled: true,
    };
  }

  if (digit === "*") {
    return silent({ kind: "keypad", subject: state.subject, digits: "", attempt: state.attempt });
  }

  return silent({
    kind: "keypad",
    subject: state.subject,
    digits: state.digits + digit,
    attempt: state.attempt,
  });
};

/**
 * Start capture for a value the agent is about to ask for.
 *
 * Used when the agent, not the caller, opens the exchange — "and your email address?".
 * The returned `say` is the question; the state makes the next turn parse as that kind.
 */
export const expecting = (kind: EntityKind): CaptureResult => ({
  // Attempt one: the question has been asked. Starting at zero gave the caller three
  // goes at a question they had already shown they could not hear.
  state: { kind: "awaiting", expect: kind, attempt: 1 },
  say: forSpeech(ENTITY_POLICY[kind].ask),
  captured: null,
  capturedKind: null,
  handled: true,
});

export const advance = (state: CaptureState, event: CaptureEvent): CaptureResult => {
  // Terminal for capture, not for the call. Both states are released rather than
  // swallowed — see `handled`. `escalate` in particular used to make the agent go silent
  // for the rest of the call, having just promised the caller a colleague.
  if (state.kind === "confirmed" || state.kind === "escalate") return released(state);

  if (event.kind === "keypad") {
    if (state.kind !== "keypad") return released(state);
    return onKeypad(state, event.digit);
  }

  const atMs = event.at ?? Date.now();

  switch (state.kind) {
    case "idle":
      return start(event.text, atMs, event.confidence);
    case "awaiting":
      return awaiting(state, event.text, atMs, event.confidence);
    case "confirming":
      return confirming(state, event.text, atMs);
    case "spelling":
      return spelling(state, event.text, atMs);
    case "keypad": {
      // Talking instead of typing. Repeat the instruction once, then hand over.
      if (state.attempt >= 1) return escalate();
      return {
        state: { ...state, kind: "keypad", attempt: state.attempt + 1 },
        say: keypadPrompt,
        captured: null,
        capturedKind: null,
        handled: true,
      };
    }
  }
};
