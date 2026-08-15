"use server";

import { revalidatePath } from "next/cache";

import { failureMessage } from "@/lib/api/server";
import { failedForm, invalidForm, succeededForm, type FormState } from "@/lib/form-state";

import { credentialDeleteSchema, credentialFormSchema, webhooksFormSchema } from "./connect.schema";
import { putCredential, removeCredential, replaceSubscriptions } from "./connect.service";

// ---------------------------------------------------------------------------
// Webhooks (event subscriptions)
// ---------------------------------------------------------------------------

export interface SavedSubscriptions {
  readonly configVersion: number;
}

export type SaveSubscriptionsState = FormState<SavedSubscriptions>;

/**
 * Replace the event subscription document.
 *
 * `subscriptions` arrives as JSON in a hidden field rather than indexed form fields — see
 * `connect.schema.ts` for why — so this parses that once, up front, and returns the same
 * "invalid" shape a bad JSON payload would produce from a schema failure: the client
 * component never sends malformed JSON on its own, so reaching this branch means the hidden
 * field was tampered with, not that a user mistyped something.
 */
export const saveSubscriptions = async (
  _previous: SaveSubscriptionsState,
  form: FormData,
): Promise<SaveSubscriptionsState> => {
  const rawSubscriptions = form.get("subscriptionsJson");
  let subscriptions: unknown;
  try {
    subscriptions = JSON.parse(typeof rawSubscriptions === "string" ? rawSubscriptions : "[]");
  } catch {
    return failedForm("The receiver list could not be read. Reload the page and try again.");
  }

  const parsed = webhooksFormSchema.safeParse({
    expectedVersion: form.get("expectedVersion") ?? "",
    note: form.get("note") ?? "",

    allowedHosts: form.get("allowedHosts") ?? "",
    allowPlaintextHttp: form.get("allowPlaintextHttp") !== null,

    minDigits: form.get("minDigits") ?? "",
    minSpokenDigits: form.get("minSpokenDigits") ?? "",

    subscriptions,
  });

  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const result = await replaceSubscriptions(parsed.data);
    // The page renders from the live document, so without this it keeps showing the
    // version the form was built from and the next save carries stale fields forward.
    revalidatePath("/webhooks");
    return succeededForm({ configVersion: result.configVersion });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface SavedCredential {
  readonly ref: string;
}

export type SaveCredentialState = FormState<SavedCredential>;

/**
 * Store or rotate a credential.
 *
 * Never echoes back what was submitted: the whole point of this screen is that a secret
 * goes in and only its name and dates come out, and returning the value here — even to a
 * page that would immediately discard it — would be one bug away from putting it on screen.
 */
export const saveCredential = async (
  _previous: SaveCredentialState,
  form: FormData,
): Promise<SaveCredentialState> => {
  const parsed = credentialFormSchema.safeParse({
    ref: form.get("ref") ?? "",
    kind: form.get("kind") ?? "",
    token: form.get("token") ?? "",
    header: form.get("header") ?? "",
    value: form.get("value") ?? "",
    username: form.get("username") ?? "",
    password: form.get("password") ?? "",
    secret: form.get("secret") ?? "",
  });

  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const result = await putCredential(parsed.data);
    revalidatePath("/credentials");
    return succeededForm({ ref: result.ref });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

export type DeleteCredentialState = FormState<{ readonly ref: string }>;

/**
 * Remove a credential.
 *
 * Refused with 409 while a tool or event subscription still names it — `failureMessage`
 * surfaces the API's own detail for that, which says which configuration is holding it,
 * rather than this screen guessing.
 */
export const deleteCredential = async (
  _previous: DeleteCredentialState,
  form: FormData,
): Promise<DeleteCredentialState> => {
  const parsed = credentialDeleteSchema.safeParse({ ref: form.get("ref") ?? "" });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    await removeCredential(parsed.data.ref);
    revalidatePath("/credentials");
    return succeededForm({ ref: parsed.data.ref });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};
