import { confirmedFact, type CallFacts, type Fact } from "./call-facts";

/**
 * The call state as the model is allowed to see it.
 *
 * Two rules decide what appears here, and both are the reason this is a function rather
 * than a template someone fills in at the call site.
 *
 * **An unconfirmed identifier never appears as a value.** The line says a name is being
 * confirmed; it does not say which name. A model that can see the candidate will use it —
 * "thanks, Adeyemi" — and the caller then hears a wrong name asserted as fact by the same
 * agent that was supposedly still checking. The capture readback exists to catch exactly
 * that, and showing the candidate walks around it.
 *
 * **A correction appears as a count, not as the old value.** The point of telling the
 * model a correction happened is to stop it drifting back; handing it the value it must
 * not drift back to is the surest way to put that value in its mouth.
 *
 * Interpretive fields — what they want, what you are doing, what you asked — do render
 * their values at any status. They never went through a readback, getting one wrong costs
 * a clarifying question rather than the wrong account, and hiding them is what forced the
 * agent to re-derive the whole call from history every turn.
 */

const HEADER = "What you already know about this call. Read it. Do not change it.";

/**
 * The standing rules, spoken in the register of the rest of the prompt.
 *
 * These are the soft half. The hard half is that an unconfirmed value is not in the text
 * above for the model to misuse, and that `confirmedFact` is the only door to a value a
 * tool can reach. A prompt line alone would be talked out of within a call or two.
 */
const RULES: readonly string[] = [
  "They have already told you everything above. Do not ask for any of it again.",
  "Never change a name or a number yourself. If what you hear does not match what is written here, say so and ask them — do not quietly use a different one.",
];

/** How a confirmed value got its status, in a form worth saying out loud. */
const provenance = (fact: Fact): string =>
  fact.source === "business-rule" ? "It came from our records." : "They confirmed it.";

const times = (count: number): string =>
  count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;

/**
 * A confirmed identifier renders its value; an unconfirmed one renders only that it is in
 * hand. Nothing renders when there is no value at all — a list of blanks reads to the
 * model as a form to fill in, and it starts collecting rather than helping.
 */
const identifierLine = (fact: Fact, noun: string): string | null => {
  const confirmed = confirmedFact(fact);
  if (confirmed !== null) {
    return `- ${noun}: ${confirmed}. ${provenance(fact)} You may use it.`;
  }
  if (fact.status === "UNKNOWN") return null;
  return `- ${noun}: they have given it and you are still checking it. Do not use it yet, and do not ask for it again.`;
};

const interpretiveLine = (fact: Fact, lead: string): string | null => {
  if (fact.value === null) return null;
  const hedge = fact.status === "CONFIRMED" ? "" : " (your reading, not confirmed)";
  return `- ${lead}: ${fact.value}${hedge}.`;
};

export const renderFacts = (facts: CallFacts): string => {
  const lines: (string | null)[] = [
    identifierLine(facts.callerName, "Their name"),
    identifierLine(facts.policyNumber, "Their policy number"),
    identifierLine(facts.customerId, "Their customer id"),
    /* The operator's own fields, by the key the task layer already used to ask for them.
       The key rather than a prettified noun on purpose: the model is told "collect
       policyNumber" in one section and "you have policyNumber" in this one, and those have
       to be recognisably the same thing. Without this the caller confirms their claim
       number, the agent hears it, stores it, hands it to a tool — and then asks for it
       again, because the only place it was written down was somewhere the model cannot
       see. */
    ...[...facts.captured].map(([key, fact]) => identifierLine(fact, `Their ${key}`)),
    interpretiveLine(facts.intent, "What they want"),
    interpretiveLine(facts.reasonForCall, "Why they called"),
    interpretiveLine(facts.currentTask, "What you are doing right now"),
    facts.pendingQuestion.value === null
      ? null
      : `- You asked them: "${facts.pendingQuestion.value}". They have not answered yet.`,
  ];

  const NOUNS: Readonly<Record<string, string>> = {
    callerName: "their name",
    policyNumber: "their policy number",
    customerId: "their customer id",
  };

  // Configured fields correct too, and a correction the model is not told about is the one
  // it undoes: it goes back to the value the caller has already rejected once.
  for (const field of [...Object.keys(NOUNS), ...facts.captured.keys()]) {
    const count = facts.previousCorrections.filter((c) => c.field === field).length;
    if (count === 0) continue;
    const noun = NOUNS[field] ?? `their ${field}`;
    lines.push(
      `- They have already corrected ${noun} ${times(count)}. Do not go back to what you had before.`,
    );
  }

  const known = lines.filter((line): line is string => line !== null);
  // Nothing yet. Turn one gets no block at all rather than a paragraph explaining that
  // the agent knows nothing, which is both a waste of the prompt and an odd thing to read.
  if (known.length === 0) return "";

  /* How to use what is known. Everything above is there to be used, not only recorded:
     the particular said back — the name, the number, the place — is what tells a caller
     they were listened to. The name gets its own lines once there is one, because it is
     the single biggest thing that makes a call feel like a person was on it and the
     easiest to overdo: a name in every sentence is a telesales script. */
  const usingIt = [
    "Use all of this wherever a person who was listening would: say the particular back — the place, the number, the thing they asked for — rather than \"that\" or \"your request\".",
    ...(facts.callerName.status === "UNKNOWN"
      ? []
      : [
          "Use their name the way a person would: when you first have it, when you reassure them, when you ask something that matters, when you have to give bad news, when you correct yourself, and when you say goodbye. Wherever it fits — and not in every sentence.",
          "First name, unless they gave a title with it. Never add Mr or Mrs yourself. If they have been calling you sir or ma, give it back at the moments it fits: \"Of course, ma.\" \"Goodbye, Mr Adewale.\"",
        ]),
  ];

  return [HEADER, "", ...known, "", ...RULES, ...usingIt].join("\n");
};
