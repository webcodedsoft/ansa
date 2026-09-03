import { z } from "zod";

import { E164, E164_MESSAGE } from "@/lib/patterns";

/**
 * Schemas for the agent workspace.
 *
 * `publishSchema` is the important one. `POST /config/versions` rewrites the whole
 * configuration and snapshots the result — it is not a patch — so a body missing a field
 * does not leave that field alone, it clears it. Building the body here, from a schema that
 * names every field, means a field cannot be forgotten silently: it has to be removed from
 * the schema, which is visible in a diff. This is ported from the singular `agent` feature
 * this replaces; the field names are unchanged because the API did not change.
 */

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} cannot be longer than ${max} characters.`)
    .transform((value) => (value === "" ? null : value));

/**
 * Keyterms from one textarea.
 *
 * Split on newlines and commas because people use both, deduplicated because the same term
 * twice buys nothing and counts twice against the cap. Order is preserved.
 */
const keyterms = z
  .string()
  .transform((raw) => [
    ...new Set(
      raw
        .split(/[\n,]/)
        .map((term) => term.trim())
        .filter((term) => term !== ""),
    ),
  ])
  .pipe(
    z
      .array(z.string().max(100, "A keyterm cannot be longer than 100 characters."))
      .max(100, "That is more than 100 keyterms."),
  );

/**
 * The organisation's own rules, as blocks the prompt renders under headings.
 *
 * Carried through the form as one JSON string rather than as flat fields, and that is a
 * deliberate exception to how everything else here travels. A policy block is a name, a
 * sentence and three lists of sentences; expressing twelve of those as `FormData` keys means
 * inventing an index-in-the-name convention and a parser for it, and that convention is the
 * bug — a dropped index silently merges two policies.
 *
 * Parsed defensively for the same reason the API parses it again: this arrives as a string
 * from a hidden input, so it is untrusted in exactly the way a text field is. Anything that
 * is not the expected shape fails the form rather than reaching the publish half-formed.
 */
const policyLine = z.string().trim().min(1).max(300);

const policyBlock = z.object({
  name: z.string().trim().min(1, "A policy needs a name.").max(80, "That policy name is too long."),
  applies: z
    .string()
    .trim()
    .min(1, "Say when this policy applies, or the model cannot tell which one to use.")
    .max(300, "That is too long for one line."),
  canDo: z.array(policyLine).max(12, "That is more than 12 lines."),
  cannotDo: z.array(policyLine).max(12, "That is more than 12 lines."),
  escalateWhen: z.array(policyLine).max(12, "That is more than 12 lines."),
});

/**
 * Optional, and the three states are all different.
 *
 * Absent — the field never rendered — leaves the stored policies alone, because a screen that
 * cannot edit them must not be able to delete them. That is the rule migration 0046's
 * `coalesce` enforces in the database, and this is the same rule on the way in.
 *
 * Present and empty is a decision: this agent has no policies, delete the ones it had. An
 * editor that could not express that would make the last policy undeletable.
 */
const policyBlocks = z.optional(
  z
    .string()
    .transform((raw, context) => {
      if (raw.trim() === "") return [];
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        context.addIssue({ code: "custom", message: "The policies could not be read." });
        return z.NEVER;
      }
    })
    .pipe(z.array(policyBlock).max(12, "That is more than 12 policies.")),
);

const CONFIG_SHAPE = {
  name: z.string().trim().min(1, "The agent needs a name.").max(120, "That name is too long."),
  voiceId: optionalText(200, "The voice id"),
  /* Empty means the voice's own pace, which is not 1.0 — the slider sends "" at 1.00 for
     exactly that reason, and coercing "" to a number would turn it into 0. */
  speakingRate: z
    .union([z.literal(""), z.coerce.number().min(0.7).max(1.2)])
    .transform((value) => (value === "" ? null : value)),
  greeting: optionalText(500, "The greeting"),
  persona: optionalText(400, "The persona"),
  instructions: optionalText(2000, "The instructions"),
  keyterms,

  escalationEnabled: z.boolean(),
  toNumber: z.string().trim(),
  fromNumber: z.string().trim(),
  ringSeconds: z.union([z.literal(""), z.coerce.number().int().min(5).max(120)]),

  policyBlocks,
} as const;

/**
 * Why a version exists.
 *
 * On the publish schema and not on the draft one, which is the whole distinction between
 * them: a note explains a version, and a draft is not a version. Saving asks for nothing.
 */
const note = z
  .string()
  .trim()
  .min(1, "Say what changed. A version with no reason explains nothing later.")
  .max(500, "That note is too long.");

const publishForm = z.object({ ...CONFIG_SHAPE, note });
const draftForm = z.object({ ...CONFIG_SHAPE });

/**
 * The rules that only apply when a section is switched on.
 *
 * Shared by both schemas rather than written twice. A draft that validated more loosely than
 * a publish would be a trap — the operator is told it saved and finds out it was never
 * publishable at the moment they wanted it live — and one that validated differently would
 * be worse, because the difference would only appear on the fields nobody tests.
 */
type ConfigShape = z.infer<z.ZodObject<typeof CONFIG_SHAPE>>;

const checkSections = (value: ConfigShape, context: z.RefinementCtx): void => {
  /* No hours check any more: they left this document in migration 0053 and are set through
     the organisation, which validates them itself. */
  if (!value.escalationEnabled) return;
  if (!E164.test(value.toNumber)) {
    context.addIssue({ code: "custom", path: ["toNumber"], message: E164_MESSAGE });
  }
  if (!E164.test(value.fromNumber)) {
    context.addIssue({ code: "custom", path: ["fromNumber"], message: E164_MESSAGE });
  }
};

/** The body both endpoints take, from the flat fields the form submits. */
const toDocument = (value: ConfigShape) => ({
  name: value.name,
  voiceId: value.voiceId,
  speakingRate: value.speakingRate,
  greeting: value.greeting,
  persona: value.persona,
  instructions: value.instructions,
  keyterms: value.keyterms,
  escalation: value.escalationEnabled
    ? {
        toNumber: value.toNumber,
        fromNumber: value.fromNumber,
        ringSeconds: value.ringSeconds === "" ? null : value.ringSeconds,
      }
    : null,
  /* An empty array, not null, and the difference reaches the database. `publish_agent_config`
     coalesces null to the stored value so a screen with no policy editor cannot wipe them —
     see migration 0046. This screen has one, so it must say "none" rather than "unchanged",
     or deleting the last policy would silently do nothing. */
  policyBlocks: value.policyBlocks,
});

export const publishSchema = publishForm
  .superRefine(checkSections)
  .transform((value) => ({ ...toDocument(value), note: value.note }));

/** Identical, minus the note. Saving is not a version and has nothing to explain. */
export const draftSchema = draftForm.superRefine(checkSections).transform(toDocument);

export type DraftBody = z.infer<typeof draftSchema>;

export type PublishBody = z.infer<typeof publishSchema>;

/** Reads the fields this form needs out of a `FormData`, the shape `publishSchema` expects. */
export const publishFormInput = (form: FormData) => ({
  name: form.get("name") ?? "",
  voiceId: form.get("voiceId") ?? "",
  speakingRate: form.get("speakingRate") ?? "",
  greeting: form.get("greeting") ?? "",
  persona: form.get("persona") ?? "",
  instructions: form.get("instructions") ?? "",
  keyterms: form.get("keyterms") ?? "",

  escalationEnabled: form.get("escalationEnabled") !== null,
  toNumber: form.get("toNumber") ?? "",
  fromNumber: form.get("fromNumber") ?? "",
  ringSeconds: form.get("ringSeconds") ?? "",

  note: form.get("note") ?? "",

  /* One hidden field holding JSON — see `policyBlocks` above for why this one is not flat.
     Undefined when the field is absent, and deliberately not "": absent means the editor did
     not render, and an agent whose policies cannot be edited on this screen must not have
     them cleared by it. An empty string is the editor saying there are none. */
  policyBlocks: form.get("policyBlocks") ?? undefined,
});

/** A test call: ring a number and let the live configuration answer it. */
export const testCallSchema = z.object({
  to: z.string().trim().regex(E164, E164_MESSAGE),
});

export type TestCallInput = z.infer<typeof testCallSchema>;

/**
 * The tool registry, edited as one JSON document.
 *
 * `PUT /tools` rewrites the whole document the same way a configuration publish does —
 * `expectedVersion` guards against overwriting a change nobody has seen yet. A structured
 * per-tool editor is the better long-term shape; this is the honest version that ships
 * today without inventing form fields the API does not need and a reviewer would have to
 * guess the intent of.
 */
/** Arguments for running a tool with `POST /tools/{name}/test`. */
export const testToolSchema = z.object({
  name: z.string().min(1),
  argumentsJson: z
    .string()
    .transform((raw) => (raw.trim() === "" ? "{}" : raw))
    .refine((raw) => {
      try {
        JSON.parse(raw);
        return true;
      } catch {
        return false;
      }
    }, "That is not valid JSON."),
});

/**
 * One thing the agent asks a caller for.
 *
 * Mirrors the API's own schema rather than inventing a looser one: the server validates
 * this again on the way in, and a client that accepted more would only turn a clear form
 * error into a 422 from somewhere else.
 */
export const capturedFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, "A field needs a name.")
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Use letters, digits and underscores, starting with a letter."),
  type: z.enum(["name", "reference", "phone", "email", "address", "date", "time", "amount", "nin", "bvn", "otp", "quantity", "choice", "text"]),
  prompt: z.string().max(300),
  capture: z.enum(["speech", "keypad", "either"]),
  confirm: z.enum(["none", "readback", "spellback"]),
  pattern: z.string().max(200),
  attempts: z.number().int().min(1).max(10),
  required: z.boolean(),
  options: z.array(z.string().max(120)).max(24),
});

export type CapturedField = z.infer<typeof capturedFieldSchema>;

/** The API's cap on a form, and therefore on what a graph may project back to. */
export const MAX_CAPTURED_FIELDS = 40;

export const capturedFieldsSchema = z.array(capturedFieldSchema).max(MAX_CAPTURED_FIELDS);
