"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Notice, Stack, SubmitButton, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFailureToast } from "@/stores/toast.store";

import { resetPassword, type ResetPasswordState } from "../auth.actions";

const START: ResetPasswordState = idleForm();

/**
 * A new password, twice. The token comes from the link and is never shown or editable,
 * for the same reason the invitation form hides its own: it is a bearer credential.
 * A dead link comes back on `token`, which has no field, so it is a notice with the way out.
 */
export const ResetPasswordForm = ({ token }: { readonly token: string }) => {
  const [state, action, pending] = useActionState(resetPassword, START);
  useFailureToast(state);
  const dead = state.fieldErrors["token"];

  return (
    <form action={action}>
      <Stack>
        <input type="hidden" name="token" value={token} />
        {dead !== undefined && (
          <Notice tone="error">
            This link {dead}{" "}
            <Link href="/forgot-password" className="font-medium underline">
              Ask for a new one
            </Link>
            .
          </Notice>
        )}
        <TextField
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          error={state.fieldErrors["password"]}
          hint="At least 12 characters. A few unrelated words is easier to remember than symbols."
        />
        <TextField
          label="New password again"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          error={state.fieldErrors["confirmPassword"]}
        />
        <SubmitButton pending={pending} idle="Change password" className="w-full" />
      </Stack>
    </form>
  );
};
