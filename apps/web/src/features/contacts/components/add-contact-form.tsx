"use client";

import { useActionState } from "react";

import { Button, Notice, Stack, SubmitButton, TextAreaField, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { addContactAction, type AddContactState } from "../contacts.actions";

const START: AddContactState = idleForm();

/**
 * Add one person by hand, for somebody the office knows about who has not rung yet.
 *
 * The phone is the only thing insisted on, because a contact is a number first. Adding a number
 * that has already called does not make a second record — the API upserts and answers
 * `created: false`, and this says "already on your list" rather than claiming a new person, so
 * the count at the top of the page stays true.
 *
 * A malformed number is a 422 the action maps back onto the phone field, so the complaint lands
 * under the box rather than in the banner.
 */
export const AddContactForm = ({ onClose }: { readonly onClose: () => void }) => {
  const [state, action, pending] = useActionState(addContactAction, START);
  const errors = state.fieldErrors;
  const added = state.status === "succeeded" ? state.data : null;

  if (added !== null) {
    return (
      <Stack gap="sm">
        <Notice tone={added.created ? "ok" : "info"}>{state.message}</Notice>
        <div className="flex justify-end">
          <Button type="button" variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </Stack>
    );
  }

  return (
    <form action={action}>
      <Stack gap="sm">
        <TextField
          label="Phone number"
          name="phone"
          required
          inputMode="tel"
          autoComplete="tel"
          placeholder="080 1234 5678"
          error={errors["phone"]}
          hint="A Nigerian number can be written however you have it — it is tidied to +234 when saved."
        />
        <TextField
          label="Name"
          name="displayName"
          placeholder="What to call them"
          error={errors["displayName"]}
        />
        <TextAreaField
          label="Notes"
          name="notes"
          placeholder="Anything worth remembering before they ring"
          error={errors["notes"]}
        />
        {(state.status === "failed" || state.status === "invalid") && state.message !== null && (
          <Notice tone="error">{state.message}</Notice>
        )}
        <div className="flex justify-end">
          <SubmitButton pending={pending} idle="Add contact" busy="Adding…" />
        </div>
      </Stack>
    </form>
  );
};
