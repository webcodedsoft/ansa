import { z } from "zod";

/**
 * Schemas for the Connect section: numbers, event subscriptions (webhooks) and credentials.
 *
 * The webhooks half is the one that matters most. `eventSubscriptions.replace` overwrites the
 * whole document in one PUT — there is no patch verb — so every schema here that feeds it
 * names every field the read side returns. A field this form never rendered would otherwise
 * fall out of the body silently, and the API reads a missing field as "delete it," not
 * "leave it alone."
 */

// ---------------------------------------------------------------------------
// Shared vocabulary — copied from the API's own enums, not invented here.
// ---------------------------------------------------------------------------

export const EVENT_KINDS = ["call.ended", "call.transferred"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const REDACTION_CATEGORIES = [
  "captured-identifier",
  "email",
  "card-number",
  "digit-sequence",
  "spoken-digit-sequence",
] as const;
export type RedactionCategory = (typeof REDACTION_CATEGORIES)[number];

/** A number field that may be left blank, meaning "use the default" rather than zero. */
const optionalCount = z.union([z.literal(""), z.coerce.number().int().min(0)]);

const redactionDocSchema = z.object({
  categories: z.array(z.enum(REDACTION_CATEGORIES)),
  minDigits: z.number().int().min(0).optional(),
  minSpokenDigits: z.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Webhooks (event subscriptions)
// ---------------------------------------------------------------------------

/**
 * One receiver, as it round-trips through client state.
 *
 * Managed as a JS array in the form component rather than as indexed
 * `subscriptions[0].url`-style field names, because the list grows and shrinks and
 * reconstructing an array of objects from flat, re-indexed FormData keys is exactly the kind
 * of thing that silently drops a field when a row is removed from the middle. `redaction` has
 * no editor here — there is nowhere on this screen to set a per-receiver override — so it is
 * only ever read from the API and carried back untouched.
 */
const subscriptionDraftSchema = z
  .object({
    name: z.string().trim().min(1, "Every receiver needs a name.").max(120, "That name is too long."),
    url: z.url("Enter a full URL, including the scheme."),
    events: z.array(z.enum(EVENT_KINDS)).min(1, "Pick at least one event."),
    signingSecretRef: z
      .string()
      .trim()
      .min(1, "Name the credential holding the signing secret."),
    credentialRef: z.string().trim(),
    timeoutMs: optionalCount,
    maxAttempts: optionalCount,
    redaction: redactionDocSchema.nullable(),
  })
  .transform((value) => ({
    name: value.name,
    url: value.url,
    events: value.events,
    signingSecretRef: value.signingSecretRef,
    ...(value.credentialRef === "" ? {} : { credentialRef: value.credentialRef }),
    ...(value.timeoutMs === "" ? {} : { timeoutMs: value.timeoutMs }),
    ...(value.maxAttempts === "" ? {} : { maxAttempts: value.maxAttempts }),
    ...(value.redaction === null ? {} : { redaction: value.redaction }),
  }));

/**
 * Hosts, one per line or comma-separated — the same convention `agent.schema.ts` uses for
 * keyterms, kept for the same reason: people paste lists in both shapes.
 */
const hostsList = z
  .string()
  .transform((raw) => [
    ...new Set(
      raw
        .split(/[\n,]/)
        .map((host) => host.trim())
        .filter((host) => host !== ""),
    ),
  ])
  .pipe(z.array(z.string().max(255, "A host cannot be longer than 255 characters.")));

export const webhooksFormSchema = z
  .object({
    expectedVersion: z.coerce.number().int(),
    note: z.string().trim().max(500, "That note is too long."),

    allowedHosts: hostsList,
    allowPlaintextHttp: z.boolean(),

    redactionEnabled: z.boolean(),
    redactionCategories: z.array(z.enum(REDACTION_CATEGORIES)),
    minDigits: optionalCount,
    minSpokenDigits: optionalCount,

    subscriptions: z.array(subscriptionDraftSchema),
  })
  .transform((value) => ({
    expectedVersion: value.expectedVersion,
    ...(value.note === "" ? {} : { note: value.note }),
    egress: {
      allowedHosts: value.allowedHosts,
      allowPlaintextHttp: value.allowPlaintextHttp,
    },
    ...(value.redactionEnabled
      ? {
          redaction: {
            categories: value.redactionCategories,
            ...(value.minDigits === "" ? {} : { minDigits: value.minDigits }),
            ...(value.minSpokenDigits === "" ? {} : { minSpokenDigits: value.minSpokenDigits }),
          },
        }
      : {}),
    subscriptions: value.subscriptions,
  }));

export type WebhooksBody = z.infer<typeof webhooksFormSchema>;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export const CREDENTIAL_KINDS = ["bearer", "header", "basic", "signing"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

const credentialRef = z
  .string()
  .trim()
  .min(1, "Name this credential.")
  .max(200, "That name is too long.");

/**
 * Store or rotate a credential.
 *
 * A discriminated union on `kind` rather than one object with every field optional, because
 * the API's own body is shaped that way — a `bearer` credential has a `token` and nothing
 * else, a `basic` one has a username and password and no `token` at all — and a looser schema
 * here would accept combinations the API would 422 on anyway, just later and less clearly.
 */
export const credentialFormSchema = z.discriminatedUnion("kind", [
  z.object({
    ref: credentialRef,
    kind: z.literal("bearer"),
    token: z.string().trim().min(1, "Enter the bearer token."),
  }),
  z.object({
    ref: credentialRef,
    kind: z.literal("header"),
    header: z.string().trim().min(1, "Name the header."),
    value: z.string().trim().min(1, "Enter the header value."),
  }),
  z.object({
    ref: credentialRef,
    kind: z.literal("basic"),
    username: z.string().trim().min(1, "Enter the username."),
    password: z.string().trim().min(1, "Enter the password."),
  }),
  z.object({
    ref: credentialRef,
    kind: z.literal("signing"),
    secret: z.string().trim().min(1, "Enter the signing secret."),
  }),
]);

export type CredentialFormInput = z.infer<typeof credentialFormSchema>;

export const credentialDeleteSchema = z.object({
  ref: credentialRef,
});
