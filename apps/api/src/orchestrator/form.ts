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
  /**
   * How many goes this field took, counting the one that worked.
   *
   * Stored with the value so the console can show which questions callers struggle with.
   * A field averaging three attempts has a prompt that needs rewriting, and that is only
   * visible if the number survives the call.
   */
  attemptsFor(key: string): number;
  /** Nothing required is still outstanding. Optional fields do not hold a call open. */
  complete(): boolean;
  /**
   * A question the model answers on the caller's behalf, or null when `key` is not one.
   *
   * The engine hears names, numbers and identifiers — values with a shape. A choice has no
   * shape: "I'd like to rent, I think" is `rent`, and only the model can say so. So the model
   * records those through `record_answer`, and this is how the tool learns whether a key is
   * that kind of question and what it may be answered with. Free text is answerable with
   * anything; a choice with one of its options; everything else with nothing, because the
   * engine will hear it and read it back, and a model-supplied value would skip that.
   */
  answerable(key: string): { readonly type: string; readonly options: readonly string[] } | null;
  /**
   * What the model should do next, or null when the standing prompt already says.
   *
   * The list director returns null: its questions are stated once, in order, in the system
   * prompt, and that has always been enough for a list. A graph cannot be stated once — which
   * question comes next depends on the answers so far — so the graph director writes this
   * fresh each turn and the orchestrator puts it in front of the model beside the situation.
   */
  guidance(): Guidance | null;
  readonly values: ReadonlyMap<string, CapturedValue>;
}

/**
 * One turn's steering, from the director to the model.
 *
 * `cover` is what to say before or while doing `next` — the `say` steps passed on the way
 * here, in order. `tools` are the tools the graph asks for at this point. `next` is the one
 * thing the call is waiting on. Rendered by `renderGuidance`; kept structured here so tests
 * can assert on what was decided rather than on wording.
 */
export interface Guidance {
  readonly cover: readonly string[];
  readonly tools: readonly string[];
  readonly next:
    /** Ask this; the engine is armed for it. */
    | { readonly kind: "ask"; readonly field: FormField }
    /** Ask this and record the answer with `record_answer`; the engine hears nothing. */
    | { readonly kind: "ask-choice"; readonly key: string; readonly prompt: string; readonly options: readonly string[] }
    /** The graph has reached its end. */
    | { readonly kind: "end" }
    /** The graph hands the call to a person here. */
    | { readonly kind: "transfer" }
    /** Nothing more the graph wants; carry on as a conversation. */
    | { readonly kind: "free" };
}

/**
 * The steering, in the model's own instructions.
 *
 * Short and imperative, because it sits nearest the generation and is the one block that
 * changes every turn. The choice case lists the options verbatim and names the tool, since
 * the option the model records has to match a branch exactly.
 */
/**
 * Said on every turn that asks for something.
 *
 * The director already accepts an answer to any question in the graph, from anywhere in the
 * call — `forVolunteered` finds the one an overheard value belongs to, `answerable` accepts
 * a recorded answer for any key, and the walk skips whatever is settled. None of that helps
 * if the model believes its instructions forbid it: "one step at a time" reads as *do not
 * accept ahead* unless something says otherwise. This is that something, and it sits here
 * rather than only in the standing prompt because it has to be true on the turn the caller
 * runs ahead, not merely somewhere in the instructions.
 */
const TAKE_WHAT_THEY_GIVE =
  "- If they tell you more than you asked for, take it: record any choice or free-text answer with record_answer now, whichever question it belongs to, and never ask again for something they have already said.";

export const renderGuidance = (guidance: Guidance): string => {
  const lines: string[] = ["Where this call is:"];
  for (const text of guidance.cover) lines.push(`- Cover this now, in your own words: ${text}`);
  for (const tool of guidance.tools) lines.push(`- Use the ${tool} tool now, before asking anything else.`);
  const next = guidance.next;
  switch (next.kind) {
    case "ask":
      lines.push(
        next.field.prompt === ""
          ? `- Next, ask for their ${next.field.key}.`
          : `- Next, ask: "${next.field.prompt}"`,
      );
      lines.push(TAKE_WHAT_THEY_GIVE);
      break;
    case "ask-choice": {
      const options = next.options.map((option) => `"${option}"`).join(", ");
      lines.push(
        next.prompt === ""
          ? `- Next, find out their ${next.key} — one of ${options}.`
          : `- Next, ask: "${next.prompt}" The answer is one of ${options}.`,
      );
      lines.push(
        `- When they have answered, record it with record_answer (field "${next.key}") using exactly one of those options. Do not move on until it is recorded.`,
      );
      lines.push(TAKE_WHAT_THEY_GIVE);
      break;
    }
    case "end":
      lines.push("- You have everything this call needed. Wrap up in their terms — what they asked for, what happens next — say goodbye, and use end_call.");
      break;
    case "transfer":
      lines.push("- This call now goes to a person. Say so, and use transfer_to_human.");
      break;
    case "free":
      lines.push("- Nothing more is needed from them. Help with whatever they ask.");
      break;
  }
  return lines.join("\n");
};

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
  /** The questions the model answers for the caller: choices and free text, by key. */
  const answerable = new Map<string, { readonly type: string; readonly options: readonly string[] }>();

  for (const field of fields) {
    const entity = asEntity(field.type);
    if (entity === null) {
      if (!answerable.has(field.key)) answerable.set(field.key, { type: field.type, options: field.options });
      continue;
    }
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

    attemptsFor: (key) => (rejections.get(key) ?? 0) + 1,

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

    answerable: (key) => answerable.get(key) ?? null,

    // The list is in the standing prompt already. Saying it again every turn would be the
    // same instruction twice, and the second copy would be the one that drifts.
    guidance: () => null,

    values,
  };
};
