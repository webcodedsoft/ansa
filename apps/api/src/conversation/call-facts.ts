import type { CallId, OrganizationId } from "@ansa/shared";
import type { CallDirection } from "@ansa/telephony";

/**
 * What the agent knows about this call, and how well it knows it.
 *
 * Until now the agent had message history and nothing else. History is a transcript, not
 * a record: to use a name the caller gave two turns ago the model had to re-read its own
 * conversation and re-derive it, and on a call where the transcriber offered three
 * spellings of that name it derived a different one each time — or asked again for
 * something it had already been told. This is the record.
 *
 * Two properties do the work, and neither is a prompt instruction:
 *
 * 1. **Every value carries a status.** Only `CONFIRMED` may reach a tool or be asserted
 *    to the caller, and `confirmedFact` is the only door to it. A value the transcriber
 *    offered once is evidence, not fact, and the difference is the difference between
 *    quoting a policy number and inventing one.
 *
 * 2. **The model may read, and may not mutate an identifier.** `observe` will not accept
 *    `source: "model"` for a name, a policy number or a customer id — refused by the type
 *    system, and refused again at runtime because an LLM tool call arrives as parsed JSON
 *    where no type was ever checked. A correction to an identifier comes from another
 *    transcription result, the caller confirming, a spelling, the keypad, or a system of
 *    record. It never comes from the model deciding that "Adeyemi" was probably "Adeyemo".
 *
 * Pure: no I/O, no clock, no config. Time arrives as `atMs` on every observation.
 */

/**
 * How well a value is known.
 *
 * - `UNKNOWN`     no value at all.
 * - `UNCERTAIN`   one transcription result. A single STT result is not evidence — the
 *                 same reasoning capture.ts uses when it prefers the most-repeated
 *                 candidate over the most recent one.
 * - `KNOWN`       two results agreeing, or the caller spelled it. Good enough to stop
 *                 asking; not good enough to act on.
 * - `CONFIRMED`   the caller heard it back and agreed, typed it on the keypad, or it came
 *                 from a system of record. The only status anything may act on.
 */
export type FactStatus = "UNKNOWN" | "UNCERTAIN" | "KNOWN" | "CONFIRMED";

/**
 * Where a value came from. The list is closed on purpose: these are the five ways an
 * identifier is allowed to change, and adding a sixth should require reading this comment.
 */
export type EvidenceSource =
  | "stt"
  | "spelling"
  | "dtmf"
  | "caller-confirmation"
  | "business-rule";

/** Evidence, plus the model — which may write what the caller *wants*, never who they are. */
export type FactSource = EvidenceSource | "model";

/**
 * Who the caller is. Getting one of these wrong means acting on the wrong account, so the
 * model is not allowed near them and nothing unconfirmed leaves this module.
 */
export type IdentifierField = "callerName" | "policyNumber" | "customerId";

/**
 * What the caller wants. Reading these is exactly what a language model is for, and
 * getting one wrong costs a clarifying question rather than a wrong account.
 */
export type InterpretiveField = "intent" | "reasonForCall" | "currentTask" | "pendingQuestion";

export type FactField = IdentifierField | InterpretiveField;

const IDENTIFIER_FIELDS: ReadonlySet<string> = new Set<IdentifierField>([
  "callerName",
  "policyNumber",
  "customerId",
]);

/** Sources that make a value actionable. Everything else is a candidate. */
const CONFIRMING: ReadonlySet<EvidenceSource> = new Set<EvidenceSource>([
  "dtmf",
  "caller-confirmation",
  "business-rule",
]);

export interface Fact {
  readonly status: FactStatus;
  /** Null exactly when the status is UNKNOWN. */
  readonly value: string | null;
  readonly source: FactSource | null;
  /** When the value last changed. Null while UNKNOWN. */
  readonly atMs: number | null;
  /**
   * Every candidate seen for this fact, in order, including repeats — the most recent
   * few. Two entries agreeing is what promotes UNCERTAIN to KNOWN, so the repeats are
   * the point and de-duplicating this list would silently disable the promotion.
   */
  readonly heard: readonly string[];
}

/**
 * An identifier that changed after the caller had already given one.
 *
 * Kept so the agent does not drift back to a value the caller has already corrected away
 * — the same failure capture.ts's rejection memory exists to prevent, one level up and
 * for the whole call rather than one readback.
 */
export interface Correction {
  /**
   * The built-in field, or an operator-configured key.
   *
   * A string rather than the union because the agent's form decides what is collected —
   * `policyNumber` and `claimNumber` are the same kind of thing to this module, and only
   * one of them is a name this file has ever heard of.
   */
  readonly field: string;
  readonly from: string;
  readonly to: string;
  readonly source: EvidenceSource;
  readonly atMs: number;
}

/**
 * The §10 structured call state.
 *
 * `organizationId` and `callId` are on the object rather than passed alongside it, because
 * CLAUDE.md rule 3 means every log line, event and metric this state produces has to
 * carry them and a separate parameter is a thing to forget.
 *
 * `callDirection` reuses the telephony package's type rather than declaring a second
 * direction enum. Ansa answers calls; the field exists because the outbound path already
 * does, not as an invitation to grow one.
 */
export interface CallFacts {
  readonly organizationId: OrganizationId;
  readonly callId: CallId;
  readonly callDirection: CallDirection;

  readonly callerName: Fact;
  /** Derived from `callerName.status`, never stored. Two flags that can disagree is a bug. */
  readonly callerNameConfirmed: boolean;
  readonly policyNumber: Fact;
  /** Derived from `policyNumber.status`, never stored. */
  readonly policyNumberConfirmed: boolean;
  readonly customerId: Fact;

  /**
   * What the caller is calling about, as a label. Deliberately a free string and not an
   * enum: a bank's intents and a logistics firm's intents are different sets, and the
   * vocabulary belongs to organization configuration rather than to this file.
   */
  readonly intent: Fact;
  readonly reasonForCall: Fact;
  readonly currentTask: Fact;
  /** A question the agent has asked and is still waiting on. Cleared when answered. */
  readonly pendingQuestion: Fact;

  /**
   * What the agent's own form collected, by the operator's key.
   *
   * Beside the built-in three rather than replacing them: `callerName` and `policyNumber`
   * are read by name in the prompt and by the handoff summary, and a map would have made
   * every one of those a lookup that can miss. An agent whose form has no fields has an
   * empty map and behaves exactly as it did.
   */
  readonly captured: ReadonlyMap<string, Fact>;

  readonly previousCorrections: readonly Correction[];
}

export interface CallIdentity {
  readonly organizationId: OrganizationId;
  readonly callId: CallId;
  readonly callDirection: CallDirection;
}

/**
 * A single piece of evidence.
 *
 * The union is the enforcement: there is no arm of it in which an identifier field is
 * paired with `source: "model"`, so that call does not compile. The runtime check in
 * `observe` covers the path where the observation was built from parsed JSON.
 */
export type Observation =
  | {
      readonly field: IdentifierField;
      readonly value: string;
      readonly source: EvidenceSource;
      readonly atMs: number;
    }
  | {
      readonly field: InterpretiveField;
      readonly value: string;
      readonly source: FactSource;
      readonly atMs: number;
    }
  /**
   * A value the agent's configured form collected, under the operator's own key.
   *
   * Its own arm rather than a widened `field`, and that is the whole safety argument: this
   * arm takes `EvidenceSource`, which has no `"model"` member, so an observation sourced
   * from the model does not compile. The three built-in identifiers get that guarantee
   * from their arm and a configured one has to get it the same way — otherwise the first
   * agent to collect `accountNumber` would be the first whose identifier the model can
   * write.
   */
  | {
      readonly captured: string;
      readonly value: string;
      readonly source: EvidenceSource;
      readonly atMs: number;
    };

export type ChangeReason =
  /** First value for a fact that had none. */
  | "set"
  /** The same value again. Evidence strengthened, and the status may have risen with it. */
  | "agreed"
  /** Now actionable. */
  | "confirmed"
  /** An unconfirmed value was replaced by a different one. */
  | "corrected"
  /**
   * A confirmed value was contradicted, and the contradiction was NOT applied. The caller
   * may be correcting themselves, or the transcriber may have slipped; the way to tell is
   * to ask, so re-open the readback rather than swapping the value underneath the call.
   */
  | "contested"
  /** The source is not allowed to write this field, or the value was empty. */
  | "refused"
  | "unchanged";

export interface FactChange {
  /** Built-in field or configured key. See `Correction.field`. */
  readonly field: string;
  readonly applied: boolean;
  readonly reason: ChangeReason;
  readonly status: FactStatus;
}

export interface CallFactsStore {
  /** A snapshot. Reading it can never change anything. */
  readonly facts: CallFacts;
  observe(observation: Observation): FactChange;
  /**
   * Forget an interpretive value — the question was answered, the task finished.
   *
   * Identifiers are deliberately absent: a clear-then-set is a silent mutation with two
   * steps, and it would be the way round every rule above.
   */
  clear(field: InterpretiveField): void;
}

/**
 * The only door to a value that may be sent to a tool or spoken to the caller as fact.
 *
 * Anything else has to go through the readback. This returns null rather than throwing
 * because the caller's job is to ask for the value, not to crash.
 */
export const confirmedFact = (fact: Fact): string | null =>
  fact.status === "CONFIRMED" ? fact.value : null;

const UNKNOWN_FACT: Fact = {
  status: "UNKNOWN",
  value: null,
  source: null,
  atMs: null,
  heard: [],
};

/** Enough history to spot two results agreeing, and not enough to grow without bound. */
const MAX_HEARD = 8;

/** Case and spacing are transcription noise, not disagreement. */
const key = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();

const clean = (value: string): string => value.trim().replace(/\s+/g, " ");

const timesHeard = (heard: readonly string[], value: string): number =>
  heard.filter((h) => key(h) === key(value)).length;

interface Applied {
  readonly fact: Fact;
  readonly reason: ChangeReason;
  readonly correction: Correction | null;
}

const refuse = (fact: Fact): Applied => ({ fact, reason: "refused", correction: null });

/**
 * Narrows an observation to the identifier arm of the union.
 *
 * Sound only because `observe` refuses a model-sourced identifier before reaching this:
 * that pairing has no arm in the union, so it can only exist in an object that was parsed
 * rather than constructed, and it is turned away first.
 */
const isCaptured = (
  o: Observation,
): o is Extract<Observation, { readonly captured: string }> => "captured" in o;

const isIdentifierObservation = (
  o: Observation,
): o is Extract<Observation, { readonly field: IdentifierField }> =>
  !isCaptured(o) && IDENTIFIER_FIELDS.has(o.field);

const identifierFrom = (
  fact: Fact,
  field: string,
  value: string,
  source: EvidenceSource,
  atMs: number,
): Applied => {
  const confirming = CONFIRMING.has(source);
  const same = fact.value !== null && key(fact.value) === key(value);

  // A confirmed identifier is never replaced by a transcription result. The transcriber
  // has been confidently wrong about "policy" on this line; letting it overwrite a value
  // the caller heard back and agreed to would put the wrong account behind a tool call
  // with nothing on the call to show for it.
  if (fact.status === "CONFIRMED" && !confirming) {
    return same ? { fact, reason: "unchanged", correction: null } : { fact, reason: "contested", correction: null };
  }

  const heard = [...fact.heard, value].slice(-MAX_HEARD);

  if (confirming) {
    return {
      fact: { status: "CONFIRMED", value, source, atMs, heard },
      reason: "confirmed",
      correction:
        !same && fact.value !== null ? { field, from: fact.value, to: value, source, atMs } : null,
    };
  }

  // Evidence, not proof. A spelling is deliberate and letter by letter, so it is worth
  // more than one pass of an 8kHz transcriber — but it is still speech, and R4.3.1 does
  // not exempt speech from the readback.
  const status: FactStatus =
    source === "spelling" || timesHeard(heard, value) >= 2 ? "KNOWN" : "UNCERTAIN";

  if (same) {
    return {
      fact: { status, value: fact.value, source, atMs, heard },
      reason: "agreed",
      correction: null,
    };
  }

  return {
    fact: { status, value, source, atMs, heard },
    reason: fact.value === null ? "set" : "corrected",
    correction:
      fact.value !== null ? { field, from: fact.value, to: value, source, atMs } : null,
  };
};

const interpretiveFrom = (
  fact: Fact,
  value: string,
  source: FactSource,
  atMs: number,
): Applied => {
  const confirming = source !== "model" && CONFIRMING.has(source);
  const same = fact.value !== null && key(fact.value) === key(value);
  const status: FactStatus = confirming ? "CONFIRMED" : "KNOWN";

  if (same && status === fact.status) return { fact, reason: "unchanged", correction: null };

  return {
    fact: { status, value, source, atMs, heard: [...fact.heard, value].slice(-MAX_HEARD) },
    // No correction is recorded. What the caller wants moves through a call as a matter
    // of course; only an identifier changing is a correction worth remembering.
    reason: confirming ? "confirmed" : fact.value === null ? "set" : "corrected",
    correction: null,
  };
};

export const createCallFacts = (identity: CallIdentity): CallFactsStore => {
  const held: Record<FactField, Fact> = {
    callerName: UNKNOWN_FACT,
    policyNumber: UNKNOWN_FACT,
    customerId: UNKNOWN_FACT,
    intent: UNKNOWN_FACT,
    reasonForCall: UNKNOWN_FACT,
    currentTask: UNKNOWN_FACT,
    pendingQuestion: UNKNOWN_FACT,
  };
  const captured = new Map<string, Fact>();
  const corrections: Correction[] = [];

  return {
    get facts(): CallFacts {
      return {
        organizationId: identity.organizationId,
        callId: identity.callId,
        callDirection: identity.callDirection,
        callerName: held.callerName,
        callerNameConfirmed: held.callerName.status === "CONFIRMED",
        policyNumber: held.policyNumber,
        policyNumberConfirmed: held.policyNumber.status === "CONFIRMED",
        customerId: held.customerId,
        intent: held.intent,
        reasonForCall: held.reasonForCall,
        currentTask: held.currentTask,
        pendingQuestion: held.pendingQuestion,
        // Copied for the same reason the corrections are: a caller holding the live map
        // could write a fact nothing observed.
        captured: new Map(captured),
        // Copied. A caller holding the live array could append a correction that never
        // happened, which is the one list in here nobody should be able to write to.
        previousCorrections: [...corrections],
      };
    },

    observe(observation: Observation): FactChange {
      const value = clean(observation.value);

      /* A configured field follows the identifier rules exactly — confirmed beats
         unconfirmed, a contradiction of a confirmed value is contested rather than
         applied. It is collected because a tool will act on it, which is the same reason
         `policyNumber` has those rules and the reason it would be wrong to give an
         operator-named value weaker ones. */
      if (isCaptured(observation)) {
        const existing = captured.get(observation.captured) ?? UNKNOWN_FACT;
        const applied =
          value === ""
            ? refuse(existing)
            : identifierFrom(
                existing,
                observation.captured,
                value,
                observation.source,
                observation.atMs,
              );
        captured.set(observation.captured, applied.fact);
        if (applied.correction !== null) corrections.push(applied.correction);
        return {
          field: observation.captured,
          applied:
            applied.reason !== "refused" &&
            applied.reason !== "contested" &&
            applied.reason !== "unchanged",
          reason: applied.reason,
          status: applied.fact.status,
        };
      }

      const fact = held[observation.field];

      // The type system already refuses a model-sourced identifier. The check is repeated
      // here because an observation built from a model tool call is parsed JSON, where no
      // type was ever checked, and "the model may not rename the caller" is a guarantee
      // rather than a convention.
      const refused =
        value === "" ||
        (IDENTIFIER_FIELDS.has(observation.field) && observation.source === "model");

      const applied = refused
        ? refuse(fact)
        : isIdentifierObservation(observation)
          ? identifierFrom(
              fact,
              observation.field,
              value,
              observation.source,
              observation.atMs,
            )
          : interpretiveFrom(fact, value, observation.source, observation.atMs);

      held[observation.field] = applied.fact;
      if (applied.correction !== null) corrections.push(applied.correction);

      return {
        field: observation.field,
        applied: applied.reason !== "refused" && applied.reason !== "contested" && applied.reason !== "unchanged",
        reason: applied.reason,
        status: applied.fact.status,
      };
    },

    clear(field: InterpretiveField): void {
      held[field] = UNKNOWN_FACT;
    },
  };
};
