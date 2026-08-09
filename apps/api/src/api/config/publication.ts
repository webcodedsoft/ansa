import { ENFORCED_IN_CODE } from "../../prompts/guarantees";
import { compileTenantLayer } from "../../prompts/tenant-layer";
import { BASE_KEYTERMS, MAX_KEYTERMS } from "../../tenancy/defaults";
import type { FieldError } from "../http/schema";

/**
 * What a publication has to survive before it becomes a version.
 *
 * Pure — text in, complaints out — so every rule below is testable without a database, and
 * so the controller is left with nothing but the transaction.
 *
 * The rule this file exists to keep is CLAUDE.md's and `docs/MULTI_TENANT_ARCHITECTURE.md`
 * §1: **an organisation chooses its content, never whether a guarantee applies.** Two
 * distinct jobs follow from that, and it is worth being precise about which is which.
 *
 *   1. *Refusing what will be dropped.* `compileTenantLayer` already filters persona and
 *      instructions on the way into the prompt, on every config load, so a tenant who
 *      writes "skip the readback" gets a prompt without that sentence whether or not this
 *      file exists. What this adds is that they find out now, at the screen, instead of
 *      finding out never — the call path logs it and carries on, because a configuration
 *      problem must not become silence on the line (R6.2).
 *   2. *Refusing what will be silently changed.* The keyterm merge drops blank and
 *      comma-bearing terms and truncates past the cap, quietly, at call time. Publishing
 *      exactly what will be used is the difference between a vocabulary a tenant can reason
 *      about and one they have to infer from calls going wrong.
 *
 * **Neither is the boundary.** The guarantees hold in dispatch paths and in Postgres; this
 * is the courtesy that tells somebody their sentence had no effect. If this file were
 * deleted the platform would be exactly as safe and the tenant would be considerably more
 * confused.
 */

/** The one field-error shape the interceptor also produces, so a 422 reads the same either way. */
const at = (field: string, message: string): FieldError => ({ path: `body.${field}`, message });

/**
 * Persona, instructions and name, run through the same compiler the call path uses.
 *
 * `compileTenantLayer` is imported rather than re-implemented deliberately: a second copy of
 * the tripwires would drift, and the interesting property is not that these two agree today
 * but that there is only one of them. Adding a guarantee to `prompts/guarantees.ts` starts
 * being refused here in the same edit.
 */
export const guaranteeProblems = (input: {
  readonly name: string;
  readonly persona: string | null;
  readonly instructions: string | null;
}): readonly FieldError[] =>
  compileTenantLayer(input).violations.map((violation) =>
    at(
      violation.field,
      `"${violation.matched}" would weaken ${violation.guarantee}, which this platform ` +
        "enforces in code. Publishing it would not switch it off — the field would be " +
        "dropped from the prompt on every call instead. See GET /api/v1/config/guarantees.",
    ),
  );

/** Everything except whitespace, so the comparison below ignores tidying and nothing else. */
const substance = (text: string): string => text.replace(/\s+/g, "");

/**
 * Text that will reach the prompt as something other than what was written.
 *
 * `compileTenantLayer` does three things quietly on its way in: it drops lines that would
 * close the fence around tenant text (a rule, a heading, a code fence), it caps each field at
 * a number of lines, and it removes double quotes from the name because the name is the one
 * tenant string that sits outside that fence. All three are right, and all three are
 * invisible — a persona pasted in as a markdown list loses every bullet and reads back from
 * the database exactly as it was typed.
 *
 * Detected by running the real compiler and comparing, rather than by re-deriving its rules
 * here. A second copy of the fence patterns and the line caps would be a second thing to keep
 * in step, and the interesting property is that there is only one of them. Whitespace is
 * ignored, so re-indenting is not reported and a lost line is.
 */
const alteredFields = (input: {
  readonly name: string;
  readonly persona: string | null;
  readonly instructions: string | null;
}): readonly FieldError[] => {
  const blank = { name: "", persona: null, instructions: null };
  const problems: FieldError[] = [];

  for (const field of ["persona", "instructions"] as const) {
    const written = input[field];
    if (written === null) continue;
    const compiled = compileTenantLayer({ ...blank, [field]: written });
    // A field that tripped a guarantee is dropped whole and already reported above; saying
    // it was also shortened would be two complaints about one sentence.
    if (compiled.violations.length > 0) continue;
    if (substance(compiled.layer.text) !== substance(written)) {
      problems.push(
        at(
          field,
          "would not reach the prompt as written. Lines that open with a horizontal rule, a " +
            "heading or a code fence are removed — they would close the quoting around your " +
            "text — and the field is capped at a few lines. Shorten it, or send it as plain " +
            "sentences, so that what is stored is what the agent reads.",
        ),
      );
    }
  }

  const compiledName = compileTenantLayer({ ...blank, name: input.name });
  if (
    compiledName.violations.length === 0 &&
    substance(compiledName.layer.name) !== substance(input.name)
  ) {
    problems.push(
      at(
        "name",
        "would not reach the prompt as written. The name is the one thing you write that " +
          "appears outside the quoting around the rest, so it is quoted itself and double " +
          "quotes are removed from it. Send a name without them.",
      ),
    );
  }

  return problems;
};

/**
 * The vocabulary that will actually reach the transcriber: the base list with the
 * organisation's own merged on top, de-duplicated without regard to case.
 *
 * This is not a second implementation of `mergeKeyterms` in the tenant registry, and the
 * distinction matters. That function additionally drops blank terms, drops terms containing
 * a comma and truncates past the cap; `keytermProblems` below refuses every input on which
 * it would do any of those, so on anything that publishes, the merge and this agree by
 * construction rather than by coincidence. If a rule is added there, add its refusal here.
 */
export const effectiveKeyterms = (configured: readonly string[]): readonly string[] => {
  // Base first, matching the merge: if the list ever had to be cut, the terms that fail on
  // every call are the ones that survive.
  const seen = new Map<string, string>();
  for (const term of [...BASE_KEYTERMS, ...configured]) {
    const trimmed = term.trim();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }
  return [...seen.values()];
};

/**
 * Why boosting is refused rather than trimmed.
 *
 * A keyterm is a bias, not a hint: a listed token wins ties against everything unlisted.
 * Measured on 2026-08-08, three runs each way, perfectly deterministic — the base list, which
 * contains no personal name at all, turned a caller's name into a different name every time
 * on Deepgram, and removing it recovered the name every time. Boosting domain vocabulary
 * damaged an adjacent proper noun.
 *
 * So a term that the merge would have thrown away is not a small waste; it is a cost paid
 * with nothing bought, and the tenant has no way to see it happen. `tenancy/defaults.ts` has
 * the full note, including the part nobody has measured yet.
 */
export const keytermProblems = (configured: readonly string[]): readonly FieldError[] => {
  const problems: FieldError[] = [];

  configured.forEach((term, index) => {
    if (term.trim() === "") {
      problems.push(at(`keyterms.${index}`, "must not be blank"));
      return;
    }
    if (term.includes(",")) {
      problems.push(
        at(
          `keyterms.${index}`,
          "must not contain a comma. The transcriber takes one keyterm per parameter and " +
            "accepts a comma-joined value while ignoring it, so this would be a term that " +
            "looks configured and never applies. Send it as separate entries.",
        ),
      );
    }
  });

  const effective = effectiveKeyterms(configured);
  if (effective.length > MAX_KEYTERMS) {
    problems.push(
      at(
        "keyterms",
        `resolves to ${effective.length} terms and the transcriber accepts ${MAX_KEYTERMS}. ` +
          `The ${BASE_KEYTERMS.length} base terms every organisation inherits count toward ` +
          "that. Terms past the cap would be dropped, which is indistinguishable from a " +
          "transcriber that simply mishears the word.",
      ),
    );
  }

  return problems;
};

/** A publication, as the rules above need to see it. */
export interface Publication {
  readonly name: string;
  readonly persona: string | null;
  readonly instructions: string | null;
  readonly keyterms: readonly string[];
}

/**
 * Everything wrong with a publication, in one answer.
 *
 * All of it, not the first thing found: somebody fixing a configuration wants the whole list
 * rather than a conversation with the API one field at a time.
 */
export const publicationProblems = (publication: Publication): readonly FieldError[] => [
  ...guaranteeProblems(publication),
  ...alteredFields(publication),
  ...keytermProblems(publication.keyterms),
];

/** What an organisation cannot change, and where each one is actually held up. */
export interface PublishedGuarantee {
  readonly id: string;
  readonly enforcedIn: string;
  readonly restatedToTheModel: boolean;
}

/**
 * The §1 table, served rather than described.
 *
 * Read out of `prompts/guarantees.ts`, which is the same list that produces the tripwires
 * above and the block appended to every system prompt — so this cannot claim a rule the
 * platform stopped enforcing, and a dashboard explaining why a publication was refused is
 * reading the enforcement rather than a copy of it.
 */
export const publishedGuarantees = (): readonly PublishedGuarantee[] =>
  ENFORCED_IN_CODE.map((guarantee) => ({
    id: guarantee.id,
    enforcedIn: guarantee.where,
    restatedToTheModel: guarantee.spoken !== null,
  }));
