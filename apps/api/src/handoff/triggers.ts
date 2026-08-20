/**
 * When the agent should stop trying.
 *
 * Two of these already existed and fired nowhere useful: capture reaching `escalate`
 * after spelling and the keypad, and R6.4's three failed comprehensions. The three added
 * here are the ones a real call runs into first — a caller who simply asks for a person,
 * an exchange that has stopped working in either direction, and a tool that will not
 * respond.
 *
 * Everything in this file is a pure decision over things that have already happened. It
 * does not speak, dial, or write; `handoff.ts` does that, once, for every trigger. A
 * second escalation path would be a second set of rules about what the caller is told and
 * what the person answering receives, and they would diverge.
 */

export type EscalationKind =
  | "asked-for-a-person"
  | "capture-failed"
  | "repeated-misunderstanding"
  | "tool-failed"
  /**
   * An irreversible tool was asked for (R5.3).
   *
   * Distinct from `tool-failed`, which is a connector that would not answer. Nothing
   * failed here: the tier did exactly what it exists to do, and the caller should not be
   * told the assistant could not reach something when it simply may not do it.
   */
  | "needs-a-person";

export interface EscalationTrigger {
  readonly kind: EscalationKind;
  /** One clause, spoken to the person answering and written to the event log. */
  readonly detail: string;
}

/**
 * Who the caller is asking for. "Agent" is included and "assistant" is not: a caller who
 * says agent means a person, every time, whatever the industry calls this software.
 */
const PERSON =
  /\b(human(?: being)?|real person|actual person|live (?:agent|person)|person|someone|somebody|agent|representative|rep|operator|manager|supervisor|customer (?:care|service)|colleague|staff)\b/i;

/**
 * The act of being handed over. Required alongside a person word, because "is there
 * someone who handles claims?" is a question about the business and not a request to
 * leave this conversation.
 */
const HANDOVER =
  /\b(speak|speaking|talk|talking|transfer|transferred|put me|putting me|connect|connected|pass me|get me|give me|hand me|reach)\b/i;

/**
 * Wanting, asking or ordering. Nigerian English carries the request in the particle as
 * often as in the verb — "abeg" and "make I" are the ordinary forms, not slang variants.
 */
const REQUEST =
  /\b(i want|i wan|i need|i'?d like|i would like|can i|could i|may i|let me|please|abeg|make i|i must|give me|get me|put me|transfer me|connect me)\b/i;

/**
 * Said and done, not asked for.
 *
 * "I spoke to someone yesterday and they said..." contains a person, a handover verb and
 * a first person pronoun, and it is a caller giving context rather than asking to leave.
 * Matched per sentence so it only suppresses the clause it appears in.
 */
const ALREADY = /\b(spoke|talked|was speaking|was talking|had spoken|already spoke|told me)\b/i;

/** Phrases that need no frame around them: they are the request entire. */
const OUTRIGHT = [
  "put me through",
  "transfer me",
  "speak to a human",
  "talk to a human",
  "speak to a person",
  "talk to a person",
  "speak to someone",
  "talk to someone",
  "real person",
  "human being",
  "i want a human",
  "i wan person",
  "give me person",
  "make i talk to person",
  "abeg give me person",
];

/**
 * Whether the caller asked to be handed to a person.
 *
 * Exported on its own because it is worth testing against real turns without a watch
 * object around it, and because the conversation layer may want to know before the
 * escalation counters do.
 */
export const asksForAPerson = (text: string): boolean => {
  const flat = text.toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
  if (flat.length === 0) return false;
  if (OUTRIGHT.some((phrase) => flat.includes(phrase))) return true;

  for (const sentence of flat.split(/\b(?:and then|but)\b/)) {
    if (ALREADY.test(sentence)) continue;
    if (!PERSON.test(sentence)) continue;
    if (!HANDOVER.test(sentence)) continue;
    if (!REQUEST.test(sentence)) continue;
    return true;
  }
  return false;
};

export interface EscalationWatchOptions {
  /**
   * R6.4: three failed comprehension attempts, then a person. Counted across both
   * directions — the agent not understanding the caller and the caller not hearing the
   * agent are the same broken call from the caller's side of it.
   */
  readonly misunderstandingsBeforeHandoff?: number;
  /**
   * Two, not one.
   *
   * One tool failure is worth a retry and an apology: connectors time out, and a caller
   * transferred on the first blip would be transferred constantly. Two in a call means
   * the thing the caller rang about cannot be done here, and continuing to ask them
   * questions about it wastes their time.
   */
  readonly toolFailuresBeforeHandoff?: number;
}

/**
 * Counters for one call.
 *
 * Stateful because two of the four triggers are about repetition, and repetition is not
 * visible in a single turn. Each method returns the trigger when the threshold is crossed
 * and null otherwise, so the call site is one `if` and cannot forget to check a count.
 */
export const createEscalationWatch = (options: EscalationWatchOptions = {}) => {
  const misunderstandingLimit = options.misunderstandingsBeforeHandoff ?? 3;
  const toolFailureLimit = options.toolFailuresBeforeHandoff ?? 2;

  let misunderstandings = 0;
  let toolFailures = 0;
  let handedOver = false;

  /** Nothing escalates twice. The first transfer has already taken the call. */
  const once = (trigger: EscalationTrigger): EscalationTrigger | null => {
    if (handedOver) return null;
    handedOver = true;
    return trigger;
  };

  return {
    /** A caller turn, raw. Returns a trigger when they asked for a person. */
    callerSaid: (text: string): EscalationTrigger | null =>
      asksForAPerson(text)
        ? once({ kind: "asked-for-a-person", detail: "the caller asked for a person" })
        : null,

    /**
     * A turn that failed to land — a recovery line, a transcript that never arrived, a
     * readback rejected again, or the caller asking us to repeat.
     */
    misunderstood: (reason: string): EscalationTrigger | null => {
      misunderstandings += 1;
      if (misunderstandings < misunderstandingLimit) return null;
      return once({
        kind: "repeated-misunderstanding",
        detail: `the line kept breaking down — ${misunderstandings} turns went nowhere, last was ${reason}`,
      });
    },

    /**
     * A turn that worked. Resets the counter, because R6.4 is about three failures on the
     * same intent and not three failures spread across a call that was otherwise fine.
     */
    understood: (): void => {
      misunderstandings = 0;
    },

    /** Capture gave up: spelling and the keypad both failed. Always a person. */
    captureFailed: (): EscalationTrigger | null =>
      once({
        kind: "capture-failed",
        detail: "the assistant could not get their details, by voice, spelling or keypad",
      }),

    /**
     * An irreversible tool was requested. Always a person, first time, no counter: the
     * whole meaning of the tier is that this one does not execute here (R5.3).
     */
    needsAPerson: (detail: string): EscalationTrigger | null =>
      once({ kind: "needs-a-person", detail }),

    toolFailed: (name: string, outcome: string): EscalationTrigger | null => {
      toolFailures += 1;
      if (toolFailures < toolFailureLimit) return null;
      return once({
        kind: "tool-failed",
        detail: `${name} ${outcome === "timeout" ? "timed out" : "failed"}, after ${toolFailures} failures this call`,
      });
    },

    /** True once a transfer has been triggered, so nothing else tries to start one. */
    handedOver: (): boolean => handedOver,

    /**
     * Turns that went nowhere and have not been reset by one that worked.
     *
     * Read by the situation block so the agent can see the count the hard rule is counting.
     * The rule stays the rule — three and it transfers, whatever the prompt does with this
     * — but an agent that can see two failures can offer a person itself, which lands far
     * better than a transfer arriving mid-sentence on the third.
     */
    failedTurns: (): number => misunderstandings,
  };
};

export type EscalationWatch = ReturnType<typeof createEscalationWatch>;
