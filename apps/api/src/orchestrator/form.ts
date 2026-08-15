import type { CollectedField } from "../tenancy/captured-fields";

import type { EntityKind } from "./capture";

/**
 * The agent's configured form, deciding what to ask for and in what order.
 *
 * `CAPTURE_WIRING.md` §7 left `expecting(kind)` unwired with a note: "who decides *when* to
 * ask belongs to the conversation director, and nothing decides it yet". This is that
 * decision, and it comes from the agent's own configuration rather than from a list in the
 * code. Capture used to be purely reactive, so an agent only ever confirmed what a caller
 * happened to volunteer and could not ask for anything.
 *
 * What this module is not: it does not speak, it holds no state machine, and it never sees
 * a transcript. `capture.ts` owns how one value is heard, checked and read back; this owns
 * which value is wanted next and where the answer belongs. Keeping them apart is what lets
 * the engine's rules stay code while the form stays configuration.
 */

/** A field the engine can actually capture, resolved from configuration. */
export interface FormField {
  /** How tools receive it, and the key its value is stored under. */
  readonly key: string;
  readonly entity: EntityKind;
  /** The operator's wording. Empty falls back to the entity's own `ask`. */
  readonly prompt: string;
  readonly confirm: "none" | "readback" | "spellback";
  readonly required: boolean;
  /** The organisation's own format check. Empty means anything is accepted. */
  readonly pattern: string;
  /** Rejected values allowed before the call goes to a person. */
  readonly attempts: number;
  /** Whether a heard value satisfies the operator's format. True when they set none. */
  matches(value: string): boolean;
}

/**
 * Longer than any value a caller says, and a bound on what a bad pattern can cost.
 *
 * There is no way to time out a regular expression in JavaScript, so an operator who
 * writes a backtracking one — `(a+)+$` is the classic — blocks the event loop, and this
 * process is carrying other people's calls at the same time. Capping the input is not a
 * fix, it is a ceiling: matching stays bounded by a length no real answer approaches. A
 * value over the cap fails rather than passes, because an unbounded string is not the
 * policy number the pattern was written to describe.
 */
const MAX_TESTED = 256;

/**
 * The operator's pattern, anchored, compiled once.
 *
 * Anchored because that is what everyone writing one means: `PM\\d{7}` unanchored accepts
 * `PM8592625XYZ`, which is not the format they described. HTML's own `pattern` attribute
 * makes the same choice, so the wording in the console matches what the console does.
 *
 * An invalid pattern accepts everything. It is one agent's field, written by hand, and the
 * alternative — rejecting every value — turns a typo in a text box into a call that can
 * never get past its first question.
 */
const compile = (source: string): ((value: string) => boolean) => {
  if (source === "") return () => true;

  let expression: RegExp;
  try {
    expression = new RegExp(`^(?:${source})$`);
  } catch {
    return () => true;
  }

  return (value) => value.length <= MAX_TESTED && expression.test(value);
};

export interface CapturedValue {
  readonly value: string;
  /**
   * Whether the caller agreed to a read-back of this exact value.
   *
   * False is a real state rather than a failure: a field configured `confirm: "none"` is
   * stored as heard, on purpose. What that costs is downstream — a write-tier tool naming
   * this field refuses to fire on a value nothing confirmed, and that gate is not
   * configurable.
   */
  readonly confirmed: boolean;
}

/**
 * The two kinds the engine does not capture.
 *
 * Every other configured kind maps to the entity of the same name: the field builder and
 * the engine were deliberately given one vocabulary so there is no translation to get
 * wrong. A choice and free text are heard, left in the transcript and read by the model —
 * not failures, and they must not hold the form open.
 */
const NOT_CAPTURED: ReadonlySet<string> = new Set(["choice", "text"]);

const asEntity = (type: string): EntityKind | null =>
  NOT_CAPTURED.has(type) ? null : (type as EntityKind);

export interface FormDirector {
  /**
   * The next field to ask for, or null when there is nothing left the engine can collect.
   *
   * Optional fields are included. An agent that never asks for a callback number because
   * it was optional is not honouring the configuration, it is ignoring it — skipping is a
   * decision the call makes when the caller declines, not one made here.
   */
  outstanding(): FormField | null;
  /** The field a directed answer belongs to — the one the agent last asked for. */
  asking(): FormField | null;
  /** Mark that the agent has put the question. Directed parsing needs to know. */
  beginAsking(field: FormField): void;
  /**
   * The field a volunteered value belongs to, or null when nothing wants one.
   *
   * First outstanding of that kind, and the ambiguity is real: two `reference` fields
   * cannot be told apart from a value alone. That is why a directed answer beats a
   * volunteered one, and why callers consult `asking()` first.
   */
  forVolunteered(kind: EntityKind): FormField | null;
  /** Record a value. Overwrites, because a correction is a second answer to one question. */
  satisfy(key: string, value: string, confirmed: boolean): void;
  /** The caller would not give it. Only meaningful for an optional field. */
  skip(key: string): void;
  /**
   * A value was heard perfectly and did not match the organisation's format.
   *
   * Returns whether there is another go left. Counted per field rather than per call: a
   * caller who fumbles a policy number has not used up the patience for their date of
   * birth, and carrying the count across would escalate calls that were going fine.
   */
  reject(key: string): { readonly again: boolean };
  /** Nothing required is still outstanding. Optional fields do not hold a call open. */
  complete(): boolean;
  readonly values: ReadonlyMap<string, CapturedValue>;
}

/**
 * Build a director from the agent's configuration.
 *
 * An agent with no fields gets one that is inert in every direction: `outstanding` null,
 * `forVolunteered` null, `complete` true. That is deliberate, and it is what keeps every
 * existing agent behaving exactly as it did — capture stays reactive, driven by `classify`,
 * and nothing new interferes with a call that was working yesterday.
 */
export const createForm = (fields: readonly CollectedField[]): FormDirector => {
  const ordered: FormField[] = [];
  const seen = new Set<string>();

  for (const field of fields) {
    const entity = asEntity(field.type);
    if (entity === null) continue;
    // A duplicate key would give two questions one answer slot and the second would
    // silently overwrite the first. First wins: the form is ordered, so the earlier
    // question is the one the caller was actually asked.
    if (seen.has(field.key)) continue;
    seen.add(field.key);
    ordered.push({
      key: field.key,
      entity,
      prompt: field.prompt,
      confirm: field.confirm,
      required: field.required,
      pattern: field.pattern,
      attempts: field.attempts,
      matches: compile(field.pattern),
    });
  }

  const values = new Map<string, CapturedValue>();
  const skipped = new Set<string>();
  const rejections = new Map<string, number>();
  let askingKey: string | null = null;

  const settled = (field: FormField): boolean => values.has(field.key) || skipped.has(field.key);

  return {
    outstanding: () => ordered.find((field) => !settled(field)) ?? null,

    asking: () =>
      askingKey === null ? null : (ordered.find((field) => field.key === askingKey) ?? null),

    beginAsking: (field) => {
      askingKey = field.key;
    },

    forVolunteered: (kind) =>
      ordered.find((field) => field.entity === kind && !settled(field)) ?? null,

    satisfy: (key, value, confirmed) => {
      values.set(key, { value, confirmed });
      // Cleared so a value arriving out of order does not leave the director treating a
      // later answer as directed at this question.
      if (askingKey === key) askingKey = null;
      // A caller who first declined and then gave it has given it.
      skipped.delete(key);
    },

    reject: (key) => {
      const field = ordered.find((candidate) => candidate.key === key);
      const count = (rejections.get(key) ?? 0) + 1;
      rejections.set(key, count);
      return { again: count < (field?.attempts ?? 0) };
    },

    skip: (key) => {
      skipped.add(key);
      if (askingKey === key) askingKey = null;
    },

    complete: () => ordered.every((field) => !field.required || settled(field)),

    values,
  };
};
