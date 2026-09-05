"use server";

import { revalidatePath } from "next/cache";

import { AnsaApiError } from "@/lib/api/generated";
import { failureMessage } from "@/lib/api/server";
import { failedForm, invalidForm, succeededForm, type FormState } from "@/lib/form-state";

import { addContact, importContacts } from "./contacts.service";
import { addContactSchema } from "./contacts.schema";
import { MAX_IMPORT_ROWS } from "./contacts.csv";

/**
 * Server Actions for the two write paths on the contacts page.
 *
 * Both parse, send, and revalidate `/contacts` so the directory shows the new people on the
 * next render — the same idiom every other action in this app follows. Both are reached only
 * from a `contacts:write` control, but the API enforces the capability regardless; a page that
 * hid the button is a convenience, not the guard.
 */

/**
 * A 422 from the API, turned into per-field complaints.
 *
 * The API speaks RFC 9457 and a validation failure carries one entry per field, pathed as
 * `body.phone` and the like. Mapped onto the field name, the message lands beside the box the
 * person typed in rather than in a banner that says the request did not validate. Returns null
 * when the error is not a field-level 422, so the caller can fall back to a whole-form message.
 */
const fieldErrorsFrom = (error: unknown): Readonly<Record<string, string>> | null => {
  if (!(error instanceof AnsaApiError)) return null;
  const { errors } = error.problem;
  if (errors === undefined || errors.length === 0) return null;

  const mapped: Record<string, string> = {};
  for (const entry of errors) {
    const field = entry.path.replace(/^body\./, "");
    if (mapped[field] === undefined) mapped[field] = entry.message;
  }
  return Object.keys(mapped).length === 0 ? null : mapped;
};

export interface ContactAdded {
  readonly id: string;
  readonly phone: string;
  /** False when the number was already on the list — the record returned is the existing one. */
  readonly created: boolean;
}

export type AddContactState = FormState<ContactAdded>;

export const addContactAction = async (
  _previous: AddContactState,
  form: FormData,
): Promise<AddContactState> => {
  const parsed = addContactSchema.safeParse({
    phone: form.get("phone") ?? "",
    displayName: form.get("displayName") ?? "",
    notes: form.get("notes") ?? "",
  });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const result = await addContact({
      phone: parsed.data.phone,
      ...(parsed.data.displayName === undefined ? {} : { displayName: parsed.data.displayName }),
      ...(parsed.data.notes === undefined ? {} : { notes: parsed.data.notes }),
    });
    revalidatePath("/contacts");
    return succeededForm(
      { id: result.id, phone: result.phone, created: result.created },
      result.created
        ? `Added ${result.phone} to your list.`
        : `${result.phone} is already on your list — opened the record you already have.`,
    );
  } catch (error) {
    /* A malformed number comes back as a 422 about `phone`; put it under the field rather
       than in the banner, where the person can see which box to fix. */
    const fieldErrors = fieldErrorsFrom(error);
    if (fieldErrors !== null) {
      return {
        status: "invalid",
        message: "Some of these need another look.",
        fieldErrors,
        data: null,
      };
    }
    return failedForm(failureMessage(error));
  }
};

export interface ContactsImported {
  readonly importId: string;
  readonly received: number;
  readonly added: number;
  readonly alreadyKnown: number;
  readonly skipped: number;
}

export type ImportContactsState = FormState<ContactsImported>;

/**
 * The rows are parsed in the browser and arrive here as JSON, already capped and previewed —
 * what the person saw is what is sent. The label is the filename, or "Pasted"; it is what a
 * contact's import is filed under, so a later question of "where did this person come from"
 * has an answer.
 */
export const importContactsAction = async (
  _previous: ImportContactsState,
  form: FormData,
): Promise<ImportContactsState> => {
  const sourceLabel = String(form.get("sourceLabel") ?? "").trim() || "Pasted";

  let rows: { phone: string; displayName?: string; notes?: string }[];
  try {
    rows = JSON.parse(String(form.get("rows") ?? "[]")) as typeof rows;
  } catch {
    return failedForm("The list could not be read. Paste it again and try once more.");
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return failedForm("There is nothing to import — no row carried a number we could read.");
  }
  /* The API refuses a batch over the cap outright, so a client that let one through would
     turn a truncation we could explain into a flat rejection. The parser caps too; this is
     the backstop for a caller that bypassed it. */
  if (rows.length > MAX_IMPORT_ROWS) rows = rows.slice(0, MAX_IMPORT_ROWS);

  try {
    const result = await importContacts({ sourceLabel, rows });
    revalidatePath("/contacts");
    return succeededForm(
      {
        importId: result.importId,
        received: result.received,
        added: result.added,
        alreadyKnown: result.alreadyKnown,
        skipped: result.skipped,
      },
      null,
    );
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};
