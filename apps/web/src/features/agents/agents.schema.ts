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

const publishForm = z.object({
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

  hoursEnabled: z.boolean(),
  opensAtHour: z.coerce.number().int().min(0).max(23),
  closesAtHour: z.coerce.number().int().min(1).max(24),
  openDays: z.array(z.coerce.number().int().min(1).max(7)),

  escalationEnabled: z.boolean(),
  toNumber: z.string().trim(),
  fromNumber: z.string().trim(),
  ringSeconds: z.union([z.literal(""), z.coerce.number().int().min(5).max(120)]),

  note: z
    .string()
    .trim()
    .min(1, "Say what changed. A version with no reason explains nothing later.")
    .max(500, "That note is too long."),
});

/** The rules that only apply when a section is switched on. */
export const publishSchema = publishForm
  .superRefine((value, context) => {
    if (value.hoursEnabled && value.openDays.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["openDays"],
        message: "Pick at least one day, or turn off the hours restriction.",
      });
    }
    if (!value.escalationEnabled) return;
    if (!E164.test(value.toNumber)) {
      context.addIssue({ code: "custom", path: ["toNumber"], message: E164_MESSAGE });
    }
    if (!E164.test(value.fromNumber)) {
      context.addIssue({ code: "custom", path: ["fromNumber"], message: E164_MESSAGE });
    }
  })
  .transform((value) => ({
    name: value.name,
    voiceId: value.voiceId,
    speakingRate: value.speakingRate,
    greeting: value.greeting,
    persona: value.persona,
    instructions: value.instructions,
    keyterms: value.keyterms,
    businessHours: value.hoursEnabled
      ? { opensAtHour: value.opensAtHour, closesAtHour: value.closesAtHour, openDays: value.openDays }
      : null,
    escalation: value.escalationEnabled
      ? {
          toNumber: value.toNumber,
          fromNumber: value.fromNumber,
          ringSeconds: value.ringSeconds === "" ? null : value.ringSeconds,
        }
      : null,
    note: value.note,
  }));

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

  hoursEnabled: form.get("hoursEnabled") !== null,
  opensAtHour: form.get("opensAtHour") ?? 9,
  closesAtHour: form.get("closesAtHour") ?? 17,
  openDays: form.getAll("openDays"),

  escalationEnabled: form.get("escalationEnabled") !== null,
  toNumber: form.get("toNumber") ?? "",
  fromNumber: form.get("fromNumber") ?? "",
  ringSeconds: form.get("ringSeconds") ?? "",

  note: form.get("note") ?? "",
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

export const capturedFieldsSchema = z.array(capturedFieldSchema).max(40);
