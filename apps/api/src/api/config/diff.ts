import type { TenantConfigFields } from "@ansa/db";

/**
 * What changed between two published configurations.
 *
 * Pure — two snapshots in, a list of differences out — for the same reason `publication.ts`
 * is: the interesting part is the comparison, and a comparison that needs a database to test
 * is a comparison nobody tests exhaustively.
 *
 * The question this answers is "it was working yesterday, what did we change", which on a
 * voice agent is asked about a regression somebody *heard*. So the shape is a list of the
 * fields that moved rather than two whole configurations for the reader to eyeball: a
 * greeting and a persona are paragraphs, and a diff that makes somebody find the changed
 * sentence themselves is a diff they will stop opening.
 *
 * **Leaves, not objects.** `businessHours` and `escalation` are stored as three columns
 * each, and a caller who moved closing time by an hour wants to read that rather than two
 * JSON blobs. So the comparison descends into them and reports
 * `businessHours.closesAtHour`, with a null on whichever side did not have the object at
 * all — which is how "hours were turned off" reads as three fields clearing rather than as
 * one unexplained shape change.
 *
 * **Everything renders as text**, including the numbers. The response schema this feeds has
 * integers and strings and no way to say "either", and a per-type union would put four
 * nullable fields on every row for the sake of avoiding a `String()`. A rendered value is
 * what a diff shows anyway.
 */

/** One field that is not the same in both versions. Only differences are reported. */
export interface FieldChange {
  /** Dotted path into the configuration, e.g. `greeting` or `escalation.ringSeconds`. */
  readonly field: string;
  /** Null means the field was not set in that version — distinct from an empty string. */
  readonly before: string | null;
  readonly after: string | null;
}

/**
 * Keyterms, compared as a set rather than as a list.
 *
 * They are a bias applied to the transcriber and not a sequence — reordering them changes
 * nothing on a call — so reporting "the list changed" would be true and useless. What a
 * reader needs is which words the agent started or stopped listening for, because that is
 * the change that turns a caller's name into a different name.
 */
export interface KeytermChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface ConfigDiff {
  readonly fields: readonly FieldChange[];
  readonly keyterms: KeytermChange;
  /** True when the two versions would produce the same agent. Both lists are then empty. */
  readonly identical: boolean;
}

/** Absent stays absent. `String(null)` is the string "null", which is a lie about the row. */
const render = (value: string | number | null | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

/** ISO weekdays, in the order they were stored. Rendered as one field, because they are one. */
const renderDays = (days: readonly number[] | undefined): string | null =>
  days === undefined ? null : days.join(", ");

/**
 * The leaves of one configuration, flattened to the paths the diff reports.
 *
 * Written out rather than derived by walking the object, so that adding a field to
 * `TenantConfigFields` and forgetting it here is a compile error: the record is keyed by a
 * closed list of paths and the value expressions name every property of the two nested
 * shapes. A generic walker would silently ignore the new field, which is the failure that
 * makes a diff untrustworthy — a change it does not mention reads as a change that did not
 * happen.
 */
const leaves = (config: TenantConfigFields): Readonly<Record<string, string | null>> => ({
  name: config.name,
  voiceId: render(config.voiceId),
  greeting: render(config.greeting),
  persona: render(config.persona),
  instructions: render(config.instructions),
  "businessHours.opensAtHour": render(config.businessHours?.opensAtHour),
  "businessHours.closesAtHour": render(config.businessHours?.closesAtHour),
  "businessHours.openDays": renderDays(config.businessHours?.openDays),
  "escalation.toNumber": render(config.escalation?.toNumber),
  "escalation.fromNumber": render(config.escalation?.fromNumber),
  "escalation.ringSeconds": render(config.escalation?.ringSeconds),
});

/**
 * Terms in `after` that are not in `before`, compared without regard to case.
 *
 * Case-insensitively because the keyterm merge de-duplicates that way: "Ansa" and "ansa"
 * are one term by the time the transcriber sees them, so reporting a capitalisation edit as
 * a term added and a term removed would be reporting a change to the agent's hearing that
 * did not occur.
 */
const missingFrom = (
  present: readonly string[],
  candidates: readonly string[],
): readonly string[] => {
  const known = new Set(present.map((term) => term.trim().toLowerCase()));
  return candidates.filter((term) => !known.has(term.trim().toLowerCase()));
};

export const diffConfigurations = (
  before: TenantConfigFields,
  after: TenantConfigFields,
): ConfigDiff => {
  const left = leaves(before);
  const right = leaves(after);

  const fields: FieldChange[] = [];
  for (const field of Object.keys(left)) {
    const from = left[field] ?? null;
    const to = right[field] ?? null;
    if (from === to) continue;
    fields.push({ field, before: from, after: to });
  }

  const keyterms = {
    added: missingFrom(before.keyterms, after.keyterms),
    removed: missingFrom(after.keyterms, before.keyterms),
  };

  return {
    fields,
    keyterms,
    identical: fields.length === 0 && keyterms.added.length === 0 && keyterms.removed.length === 0,
  };
};
